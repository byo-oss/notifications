import type { DeliveryContext, InboxChannel } from "../delivery";
import { PermanentDeliveryError } from "../permanent";
import {
  AUTH_SECRET_LENGTH,
  encryptPushMessage,
  type VapidSigner,
} from "./crypto";
import { fromBase64Url, toBase64Url, utf8 } from "./encoding";
import { checkEndpoint } from "./hosts";
import { buildPayload } from "./payload";
import type { PushStore } from "./store";
import type { PushTransport } from "./transport";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export type PushChannelSettings = {
  vapid: () => Promise<VapidSigner>;
  transport: PushTransport;
  ttl: number;
  urgency: PushUrgency;
  allowedHosts: readonly string[];
};

/**
 * A Topic (RFC 8030 section 5.4) is at most 32 characters of base64url. Hashing
 * the notification id keeps the id itself off the wire's plaintext part and
 * makes a retry of the same notification collapse at the push service instead
 * of showing twice.
 */
export async function topicFor(notificationId: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", utf8(notificationId) as BufferSource),
  );
  return toBase64Url(digest).slice(0, 32);
}

type Outcome = "accepted" | "gone" | "refused" | "rejected" | "retry";

/**
 * 2xx: accepted. 404 and 410: the subscription is gone. 403: the push service
 * refused our VAPID identity (the subscription belongs to another key).
 * 429, 408, 5xx and anything that isn't a real HTTP status: try again later.
 * Every other status, redirects included, can't be fixed by retrying.
 */
function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 404 || status === 410) return "gone";
  if (status === 403) return "refused";
  if (status === 429 || status === 408) return "retry";
  if (status >= 500 && status < 600) return "retry";
  if (status < 200 || status > 599) return "retry";
  return "rejected";
}

/**
 * The built-in `push` channel. Messages are encrypted (RFC 8291) and signed
 * (VAPID, RFC 8292) with WebCrypto, one request per device the user subscribed.
 *
 * Nothing thrown from here carries an endpoint, a key, a title or a body: the
 * delivery sweep stores and logs the message of what `deliver` throws, so the
 * messages hold counts and HTTP statuses only, and no error from the transport
 * (whose text can include the URL) is passed on or attached as a cause.
 */
export function createPushChannel(
  store: PushStore,
  settings: PushChannelSettings,
): InboxChannel {
  return {
    async deliver(ctx: DeliveryContext) {
      const vapid = await settings.vapid();
      let plaintext: Uint8Array;
      try {
        plaintext = buildPayload(ctx.notification, ctx.appUrl);
      } catch {
        throw new PermanentDeliveryError("web push message is too large");
      }

      const rows = await store.list(ctx.user.id);
      // rows saved under a VAPID key we no longer hold can never be pushed to
      const stale = rows.filter((row) => row.keyId !== vapid.keyId);
      const current = rows.filter((row) => row.keyId === vapid.keyId);
      await store.remove(stale.map((row) => row.id));
      if (current.length === 0) return;

      const topic = await topicFor(ctx.notification.id);
      const statuses: (number | "network")[] = [];
      const tally = { accepted: 0, retry: 0, permanent: 0 };

      await Promise.all(
        current.map(async (row) => {
          const url = checkEndpoint(row.endpoint, settings.allowedHosts);
          const p256dh = fromBase64Url(row.p256dh);
          const auth = fromBase64Url(row.auth);
          if (!url || !p256dh || !auth || auth.length !== AUTH_SECRET_LENGTH) {
            // off the allow list (it was narrowed, or the row was written
            // around the endpoint) or unusable keys: never sent to, never kept
            await store.remove([row.id]);
            tally.permanent++;
            return;
          }

          let body: Uint8Array;
          try {
            body = await encryptPushMessage({ plaintext, p256dh, auth });
          } catch {
            // a p256dh that isn't a point on the curve: no retry can fix it
            await store.remove([row.id]);
            tally.permanent++;
            return;
          }

          let status: number;
          try {
            const response = await settings.transport({
              // the parsed form: the host that was checked is the host that is called
              url: url.href,
              method: "POST",
              headers: {
                Authorization: await vapid.authorization(url),
                "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream",
                TTL: String(settings.ttl),
                Urgency: settings.urgency,
                Topic: topic,
              },
              body,
            });
            status = response.status;
          } catch {
            // no answer: the error text can hold the endpoint, so it is
            // dropped and only the fact is kept
            statuses.push("network");
            tally.retry++;
            return;
          }

          statuses.push(status);
          switch (classify(status)) {
            case "accepted":
              tally.accepted++;
              await store.touch(row.id, new Date());
              break;
            case "gone":
              // not a failure: the device unsubscribed or the browser dropped it
              await store.remove([row.id]);
              break;
            case "refused":
              await store.remove([row.id]);
              tally.permanent++;
              break;
            case "rejected":
              tally.permanent++;
              break;
            case "retry":
              tally.retry++;
              break;
          }
        }),
      );

      // Any device accepting settles the delivery, so a retry never pushes the
      // healthy ones again.
      if (tally.accepted > 0) return;
      const answered = statuses.length > 0 ? ` (${statuses.join(", ")})` : "";
      if (tally.retry > 0) {
        throw new Error(
          `web push failed for ${tally.retry + tally.permanent} of ${current.length} subscriptions${answered}, will retry`,
        );
      }
      if (tally.permanent > 0) {
        throw new PermanentDeliveryError(
          `web push refused by ${tally.permanent} of ${current.length} subscriptions${answered}`,
        );
      }
    },
  };
}
