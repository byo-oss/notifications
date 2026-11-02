import type { ByoAuth, ByoEventHandler, ByoPlugin } from "@byo-oss/core";
import type {
  AuthContext,
  BetterAuthPlugin,
  InferOptionSchema,
} from "better-auth";
import { mergeSchema } from "better-auth/db";
import {
  deleteMemberData as deleteInboxMemberData,
  deleteOrganizationData as deleteInboxOrgData,
  deleteUserRows,
  organizationCleanupHook,
} from "./data";
import {
  type DeliveryRule,
  type InboxChannel,
  processDueDeliveries,
  type ShouldDeliver,
} from "./delivery";
import { INBOX_ERROR_CODES } from "./error-codes";
import {
  listNotifications,
  markAllRead,
  markRead,
  markSeen,
  notify,
  processDeliveries,
  unreadCount,
} from "./routes";
import {
  subscribeWebPush,
  unsubscribeWebPush,
  webPushStatus,
} from "./push/endpoints";
import { resolveWebPush, type WebPushOptions } from "./push/options";
import { pushSchema, schema } from "./schema";

/** Every table, including the one `webPush` adds, so `schema` can rename it. */
const fullSchema = { ...schema, ...pushSchema };

export type InboxOptions<Channel extends string = string> = {
  /**
   * Maximum number of members an organization notify may fan out to.
   * @default 1000
   */
  maxFanout?: number;
  /**
   * Your app's origin, e.g. `https://app.acme.com`. Channels use it to turn a
   * notification's relative `href` into a link.
   */
  appUrl?: string;
  /** Delivery channels beyond the in-app inbox, by name. */
  channels?: Record<Channel, InboxChannel>;
  /**
   * Web push to the browsers users subscribe from, as a built-in channel named
   * `"push"` that `routes` can use. Off by default: without this option the
   * plugin adds no table, no routes and no channel. See `docs/push.mdx`.
   */
  webPush?: WebPushOptions;
  /**
   * Which channels each notification type goes to, keyed by `type`. `"*"` is
   * the fallback for types without an entry. Types with no rule stay in-app.
   */
  routes?: Record<string, DeliveryRule<NoInfer<Channel> | "push">[]>;
  /** Return false to skip a delivery, e.g. from your own preferences store. */
  shouldDeliver?: ShouldDeliver;
  /**
   * How recently a user must have polled the inbox to count as in the app, in ms.
   * @default 120000
   */
  presenceWindow?: number;
  /**
   * Attempts per delivery before it is marked failed. Retries back off from
   * one minute, doubling, up to an hour.
   * @default 5
   */
  maxAttempts?: number;
  /**
   * Deliveries attempted per `processDeliveries` call, an integer from 1 to
   * 1000.
   * @default 100
   */
  batchSize?: number;
  /**
   * Delete a member's notifications in an organization when they're removed
   * or leave, and an organization's when it's deleted. Turn off to keep them,
   * e.g. for an audit trail; `deleteOrganizationData` still works. Off also
   * leaves notifications out of `@byo-oss/core`'s
   * `deleteOrganizationData`/`deleteMemberData` fan-out.
   * @default true
   */
  organizationCleanup?: boolean;
  /**
   * Receives `notifications.*` events after the write commits. Errors are
   * logged, never thrown. Build it with `createEventBus` from `@byo-oss/core`.
   * Don't route these events back into `notify`.
   */
  onEvent?: ByoEventHandler;
  schema?: InferOptionSchema<typeof fullSchema>;
};

export const inbox = <Channel extends string = string>(
  options: InboxOptions<Channel> = {},
) => {
  // set in `init`: the push channel reads its table through the auth instance's adapter
  let authContext: AuthContext | undefined;
  const webPush = options.webPush
    ? resolveWebPush(options.webPush, () => authContext)
    : undefined;
  if (webPush && options.channels && "push" in options.channels) {
    throw new Error(
      '[@byo-oss/notifications] channels.push is reserved: the webPush option provides the "push" channel',
    );
  }
  const channels: Record<string, InboxChannel> = {
    ...(options.channels ?? {}),
    ...(webPush ? { push: webPush.channel } : {}),
  };
  const routes = options.routes ?? {};
  // the sweep's default limit; processDeliveries takes 1 to 1000 too
  if (
    options.batchSize !== undefined &&
    !(
      Number.isInteger(options.batchSize) &&
      options.batchSize >= 1 &&
      options.batchSize <= 1000
    )
  ) {
    throw new Error(
      `[@byo-oss/notifications] batchSize must be an integer from 1 to 1000, got ${options.batchSize}`,
    );
  }
  for (const [type, rules] of Object.entries(routes)) {
    if (type.startsWith("notifications.")) {
      throw new Error(
        `[@byo-oss/notifications] routes["${type}"] uses a reserved type: types starting with "notifications." are the plugin's own events`,
      );
    }
    const seen = new Set<string>();
    for (const rule of rules) {
      if (!channels[rule.channel]) {
        throw new Error(
          rule.channel === "push"
            ? `[@byo-oss/notifications] routes["${type}"] uses channel "push", which needs the webPush option`
            : `[@byo-oss/notifications] routes["${type}"] uses channel "${rule.channel}", which is not in channels`,
        );
      }
      if (seen.has(rule.channel)) {
        throw new Error(
          `[@byo-oss/notifications] routes["${type}"] lists channel "${rule.channel}" more than once`,
        );
      }
      seen.add(rule.channel);
    }
  }
  const opts = {
    maxFanout: options.maxFanout ?? 1000,
    appUrl: options.appUrl?.replace(/\/+$/, ""),
    channels,
    routes,
    shouldDeliver: options.shouldDeliver,
    presenceWindow: options.presenceWindow ?? 120_000,
    maxAttempts: options.maxAttempts ?? 5,
    batchSize: options.batchSize ?? 100,
    // a send that outlives this is presumed dead and its row is retried
    leaseMs: 5 * 60_000,
    // above this many due-now deliveries, notify leaves them to the sweep
    immediateLimit: 25,
    onEvent: options.onEvent,
    beforeSweep: webPush
      ? async (context: AuthContext) => {
          // subscriptions made for a VAPID key we no longer hold are dead weight
          await context.adapter.deleteMany({
            model: "pushSubscription",
            where: [{ field: "keyId", operator: "ne", value: await webPush.keyId() }],
          });
        }
      : undefined,
  };
  // the pushSubscription table exists only with webPush; a rename for it is
  // ignored otherwise, so the memory adapter and migrations never see it
  const { pushSubscription: _pushRename, ...baseRename } = options.schema ?? {};
  const mergedSchema = webPush
    ? mergeSchema(fullSchema, options.schema)
    : mergeSchema(schema, baseRename);
  return {
    id: "inbox",
    schema: mergedSchema,
    endpoints: {
      notify: notify(opts),
      processDeliveries: processDeliveries(opts),
      listNotifications: listNotifications(),
      markRead: markRead(),
      markSeen: markSeen(),
      markAllRead: markAllRead(),
      unreadCount: unreadCount(opts),
      ...(webPush
        ? {
            subscribeWebPush: subscribeWebPush(webPush),
            unsubscribeWebPush: unsubscribeWebPush(),
            webPushStatus: webPushStatus(webPush),
          }
        : ({} as {
            subscribeWebPush: ReturnType<typeof subscribeWebPush>;
            unsubscribeWebPush: ReturnType<typeof unsubscribeWebPush>;
            webPushStatus: ReturnType<typeof webPushStatus>;
          })),
    },
    init: (context) => {
      authContext = context;
      return {
        options: {
          databaseHooks: {
            user: {
              delete: {
                // SQL cascades this through foreign keys; adapters without them
                // (memory, MongoDB) would otherwise keep the rows forever
                after: async (user) => {
                  try {
                    await deleteUserRows(context, user.id, !!webPush);
                  } catch (error) {
                    context.logger.error(
                      `[@byo-oss/notifications] cleanup after deleting user ${user.id} failed`,
                      error,
                    );
                  }
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      after: options.organizationCleanup === false ? [] : [organizationCleanupHook],
    },
    $ERROR_CODES: INBOX_ERROR_CODES,
    options,
    // reached through @byo-oss/core: sweepAll, deleteOrganizationData and
    // deleteMemberData. With organizationCleanup off the cleanups are left
    // out, so core's fan-out keeps these rows too.
    byo: {
      sweep: async (auth: ByoAuth) =>
        processDueDeliveries((await auth.$context) as AuthContext, opts),
      ...(options.organizationCleanup === false
        ? {}
        : {
            deleteOrganizationData: async (
              auth: ByoAuth,
              organizationId: string,
            ) => {
              await deleteInboxOrgData(auth, organizationId);
            },
            deleteMemberData: async (
              auth: ByoAuth,
              input: { userId: string; organizationId: string },
            ) => {
              await deleteInboxMemberData(auth, input);
            },
          }),
    },
  } satisfies ByoPlugin<BetterAuthPlugin>;
};

export {
  type DeliveryContext,
  type DeliveryRule,
  type Duration,
  type InboxChannel,
  type ShouldDeliver,
  type SweepResult,
} from "./delivery";
export { PermanentDeliveryError } from "./permanent";
export { generateVapidKeys } from "./push/crypto";
export { DEFAULT_PUSH_HOSTS } from "./push/hosts";
export type { WebPushOptions } from "./push/options";
export type {
  PushPayload,
} from "./push/payload";
export type {
  PushRequest,
  PushResponse,
  PushTransport,
} from "./push/transport";
export type { PushUrgency } from "./push/channel";
export {
  type AuthWithContext,
  deleteMemberData,
  deleteOrganizationData,
  type ExportedDelivery,
  type ExportedNotification,
  type ExportNotificationsDataOptions,
  exportNotificationsData,
} from "./data";
export { INBOX_ERROR_CODES } from "./error-codes";
export {
  type DeliveryFailedEvent,
  NOTIFICATIONS_EVENT_TYPES,
  type NotificationCreatedEvent,
  type NotificationsEvent,
  type NotificationsEventType,
} from "./events";
export type {
  DeliveryStatus,
  Notification,
  NotificationDelivery,
  PushSubscriptionRow,
} from "./schema";
