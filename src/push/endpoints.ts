import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { INBOX_ERROR_CODES } from "../error-codes";
import type { PushSubscriptionRow } from "../schema";
import {
  AUTH_SECRET_LENGTH,
  isValidP256Public,
} from "./crypto";
import { fromBase64Url, toBase64Url } from "./encoding";
import { checkEndpoint, MAX_ENDPOINT_LENGTH } from "./hosts";
import type { ResolvedWebPush } from "./options";
import { MAX_SUBSCRIPTIONS_PER_USER } from "./store";

const MODEL = "pushSubscription";

// Zod issues name the field, never the value, so a refused body doesn't echo
// the endpoint. Keys are bounded so a huge string never reaches the parser.
const endpointField = z.string().min(1).max(MAX_ENDPOINT_LENGTH);

const subscribeBody = z.object({
  endpoint: endpointField,
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});

/**
 * Saves the calling user's subscription: the `endpoint` and `keys` of a
 * browser's `PushSubscription` (pass `subscription.toJSON()`). Session-only.
 * The endpoint must be https and on `allowedHosts`. Nothing else is stored; a
 * body field such as `expirationTime` is dropped. Subscribing an endpoint that
 * already exists moves it to the caller with the new keys, which is what
 * happens when a second person signs in on the same browser.
 */
export const subscribeWebPush = (push: ResolvedWebPush) =>
  createAuthEndpoint(
    "/inbox/push/subscribe",
    { method: "POST", body: subscribeBody, use: [sessionMiddleware] },
    async (ctx) => {
      const { endpoint, keys } = ctx.body;
      if (!checkEndpoint(endpoint, push.allowedHosts)) {
        throw APIError.from("BAD_REQUEST", INBOX_ERROR_CODES.PUSH_ENDPOINT_NOT_ALLOWED);
      }
      const p256dh = fromBase64Url(keys.p256dh);
      const auth = fromBase64Url(keys.auth);
      if (
        !p256dh ||
        !auth ||
        auth.length !== AUTH_SECRET_LENGTH ||
        !(await isValidP256Public(p256dh))
      ) {
        throw APIError.from("BAD_REQUEST", INBOX_ERROR_CODES.PUSH_KEYS_INVALID);
      }

      const userId = ctx.context.session.user.id;
      const adapter = ctx.context.adapter;
      const keyId = await push.keyId();
      const now = new Date();
      const fields = {
        userId,
        p256dh: toBase64Url(p256dh),
        auth: toBase64Url(auth),
        keyId,
        lastUsedAt: now,
      };
      const find = () =>
        adapter.findOne<PushSubscriptionRow>({
          model: MODEL,
          where: [{ field: "endpoint", value: endpoint }],
        });
      const update = (row: PushSubscriptionRow) =>
        adapter.update({
          model: MODEL,
          where: [{ field: "id", value: row.id }],
          update: fields,
        });

      // A database error can quote the row, and the row's endpoint is a
      // credential, so none of these errors is allowed to leave this handler.
      try {
        const existing = await find();
        if (existing) {
          await update(existing);
        } else {
          // keep a user's devices bounded: drop the longest-unused over the cap
          const mine = await adapter.findMany<PushSubscriptionRow>({
            model: MODEL,
            where: [{ field: "userId", value: userId }],
            sortBy: { field: "lastUsedAt", direction: "asc" },
            limit: 100,
          });
          const drop = mine.slice(0, Math.max(0, mine.length - (MAX_SUBSCRIPTIONS_PER_USER - 1)));
          if (drop.length > 0) {
            await adapter.deleteMany({
              model: MODEL,
              where: [{ field: "id", operator: "in", value: drop.map((row) => row.id) }],
            });
          }
          try {
            await adapter.create({
              model: MODEL,
              data: { ...fields, endpoint, createdAt: now },
            });
          } catch {
            // two first subscribes of one endpoint race on the unique column:
            // the loser updates the winner's row
            const winner = await find();
            if (!winner) throw new Error("create failed");
            await update(winner);
          }
        }
      } catch {
        ctx.context.logger.error(
          "[@byo-oss/notifications] could not save a push subscription",
        );
        throw APIError.from(
          "INTERNAL_SERVER_ERROR",
          INBOX_ERROR_CODES.PUSH_SUBSCRIPTION_FAILED,
        );
      }
      return { subscribed: true as const };
    },
  );

/** Removes the calling user's subscription for one endpoint. Session-only; never touches another user's row. */
export const unsubscribeWebPush = () =>
  createAuthEndpoint(
    "/inbox/push/unsubscribe",
    {
      method: "POST",
      body: z.object({ endpoint: endpointField }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const removed = await ctx.context.adapter.deleteMany({
        model: MODEL,
        where: [
          { field: "userId", value: ctx.context.session.user.id },
          { field: "endpoint", value: ctx.body.endpoint },
        ],
      });
      return { removed };
    },
  );

/**
 * What the browser needs to subscribe, and whether this user is: the VAPID
 * public key (it is public) as `applicationServerKey`, whether the user has any
 * device on the current key, and, when an `endpoint` is given, whether that
 * one is saved. A POST so the endpoint, a credential, never lands in a URL and
 * so in access logs. Session-only.
 */
export const webPushStatus = (push: ResolvedWebPush) =>
  createAuthEndpoint(
    "/inbox/push/status",
    {
      method: "POST",
      body: z.object({ endpoint: endpointField.optional() }).optional(),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const keyId = await push.keyId();
      const rows = await ctx.context.adapter.findMany<PushSubscriptionRow>({
        model: MODEL,
        where: [
          { field: "userId", value: ctx.context.session.user.id },
          { field: "keyId", value: keyId },
        ],
        limit: 100,
      });
      const endpoint = ctx.body?.endpoint;
      return {
        vapidPublicKey: push.vapidPublicKey,
        subscribed: rows.length > 0,
        endpointRegistered:
          endpoint === undefined ? null : rows.some((row) => row.endpoint === endpoint),
      };
    },
  );
