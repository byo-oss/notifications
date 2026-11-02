import type { AuthContext } from "better-auth";
import type { InboxChannel } from "../delivery";
import { createPushChannel, type PushUrgency } from "./channel";
import {
  createVapidSigner,
  type VapidConfig,
  type VapidSigner,
  validateVapid,
  vapidKeyId,
} from "./crypto";
import {
  DEFAULT_PUSH_HOSTS,
  validateAllowedHosts,
} from "./hosts";
import { fromBase64Url, toBase64Url } from "./encoding";
import { adapterStore } from "./store";
import { fetchTransport, type PushTransport } from "./transport";

export type { PushUrgency } from "./channel";

export type WebPushOptions = {
  /**
   * Your VAPID identity (RFC 8292). Generate a pair once with
   * `generateVapidKeys()` and keep the private key in a secret. Changing the
   * pair later invalidates every subscription: rows saved under the old key
   * are deleted.
   */
  vapid: VapidConfig;
  /**
   * How requests reach the push service. Defaults to `fetch`, without
   * following redirects. Pass `fakePushTransport()` from
   * `@byo-oss/notifications/testing` in tests.
   */
  transport?: PushTransport;
  /**
   * Seconds the push service holds a message for a device that is offline.
   * @default 86400
   */
  ttl?: number;
  /** @default "normal" */
  urgency?: PushUrgency;
  /**
   * Hosts a subscription endpoint may have, so a signed-in caller can't aim
   * the server at another address. A leading `*.` matches subdomains. This
   * replaces the default list (`DEFAULT_PUSH_HOSTS`), so spread it to extend.
   * @default DEFAULT_PUSH_HOSTS
   */
  allowedHosts?: readonly string[];
};

export type ResolvedWebPush = {
  allowedHosts: readonly string[];
  ttl: number;
  urgency: PushUrgency;
  vapidPublicKey: string;
  /** Resolves the signer once; a mismatched key pair rejects every time. */
  signer: () => Promise<VapidSigner>;
  keyId: () => Promise<string>;
  channel: InboxChannel;
};

const URGENCIES: readonly string[] = ["very-low", "low", "normal", "high"];
const fail = (message: string): never => {
  throw new Error(`[@byo-oss/notifications] ${message}`);
};

/**
 * Validates `webPush` when `inbox()` is created (a misconfiguration fails at
 * boot, not on the first push) and builds the channel. Messages never contain
 * a key.
 */
export function resolveWebPush(
  options: WebPushOptions,
  getContext: () => AuthContext | undefined,
): ResolvedWebPush {
  const vapidError = validateVapid(options.vapid ?? ({} as VapidConfig));
  if (vapidError) fail(vapidError);
  const allowedHosts = options.allowedHosts ?? DEFAULT_PUSH_HOSTS;
  const hostsError = validateAllowedHosts(allowedHosts);
  if (hostsError) fail(hostsError);
  const ttl = options.ttl ?? 86_400;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 2 ** 31 - 1) {
    fail(`webPush.ttl must be a whole number of seconds from 0 to ${2 ** 31 - 1}, got ${ttl}`);
  }
  const urgency = options.urgency ?? "normal";
  if (!URGENCIES.includes(urgency)) {
    fail(`webPush.urgency must be one of ${URGENCIES.join(", ")}, got ${String(urgency)}`);
  }
  if (options.transport !== undefined && typeof options.transport !== "function") {
    fail("webPush.transport must be a function");
  }

  let signer: Promise<VapidSigner> | undefined;
  const getSigner = () => {
    // a rejection is not cached, so fixing the environment needs no restart
    signer ??= createVapidSigner(options.vapid).catch((error) => {
      signer = undefined;
      throw error;
    });
    return signer;
  };
  let keyId: Promise<string> | undefined;
  const getKeyId = () => (keyId ??= vapidKeyId(options.vapid.publicKey));

  return {
    allowedHosts,
    ttl,
    urgency,
    vapidPublicKey: toBase64Url(fromBase64Url(options.vapid.publicKey)!),
    signer: getSigner,
    keyId: getKeyId,
    channel: createPushChannel(adapterStore(getContext), {
      vapid: getSigner,
      transport: options.transport ?? fetchTransport,
      ttl,
      urgency,
      allowedHosts,
    }),
  };
}
