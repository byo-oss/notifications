import type { ByoEventHandler } from "@byo-oss/core";
import type { AuthContext, DBTransactionAdapter, User, Where } from "better-auth";
import { findManyIn, IN_CHUNK } from "./adapter";
import { deliveryFailed, emit } from "./events";
import { isPermanent } from "./permanent";
import type {
  InboxPresence,
  Notification,
  NotificationDelivery,
} from "./schema";

export type Duration = {
  seconds?: number;
  minutes?: number;
  hours?: number;
};

export type DeliveryContext = {
  notification: Notification;
  user: User;
  /** `appUrl` from the inbox options, for turning a relative `href` into a link. */
  appUrl: string | undefined;
};

/**
 * A delivery channel. Test one with `testChannel` from
 * `@byo-oss/notifications/testing`.
 */
export type InboxChannel = {
  /**
   * Sends one notification. Resolve once the provider accepted it; throw to
   * have the delivery retried with backoff, until `maxAttempts`, after which
   * it's marked `failed` with the error in `detail`. Throw a
   * `PermanentDeliveryError` (or any error with `permanent: true`) for a send
   * that can never succeed, such as a hard bounce, to fail it at once.
   * Must not change `ctx`. Deliveries are at-least-once, so a send can repeat
   * after a crash.
   */
  deliver: (ctx: DeliveryContext) => Promise<void>;
};

export type DeliveryRule<Channel extends string = string> = {
  channel: Channel;
  /**
   * Hold the delivery and send it only if the notification is still unread and
   * unseen after this long. Omit to send right away.
   */
  ifUnreadAfter?: Duration;
  /**
   * With `ifUnreadAfter`, send right away when the user isn't in the app (no
   * inbox poll within `presenceWindow`). @default true
   */
  sendNowIfAway?: boolean;
  /**
   * Skip the send when the notification was read or seen first. Set false for
   * alerts whose email is the record, such as security events. @default true
   */
  cancelIfRead?: boolean;
  /**
   * Send at most one email of this type per user per window; later ones are
   * skipped (they're still in the inbox). For alerts that can fire repeatedly.
   */
  throttle?: Duration;
};

export type ShouldDeliver = (ctx: {
  notification: Notification;
  user: User;
  channel: string;
}) => boolean | Promise<boolean>;

export type ResolvedDeliveryOptions = {
  appUrl: string | undefined;
  channels: Record<string, InboxChannel>;
  routes: Record<string, DeliveryRule[]>;
  shouldDeliver: ShouldDeliver | undefined;
  presenceWindow: number;
  maxAttempts: number;
  batchSize: number;
  leaseMs: number;
  immediateLimit: number;
  onEvent: ByoEventHandler | undefined;
};

const PRESENCE_WRITE_INTERVAL = 60_000;
const BACKOFF_BASE = 60_000;
const BACKOFF_MAX = 60 * 60_000;

export const durationMs = (d: Duration) =>
  ((d.hours ?? 0) * 3600 + (d.minutes ?? 0) * 60 + (d.seconds ?? 0)) * 1000;

export const hasChannels = (options: ResolvedDeliveryOptions) =>
  Object.keys(options.channels).length > 0;

const rulesFor = (options: ResolvedDeliveryOptions, type: string) =>
  options.routes[type] ?? options.routes["*"] ?? [];

// init rejects a type listing one channel twice, so this lookup is unambiguous
const ruleFor = (
  options: ResolvedDeliveryOptions,
  type: string,
  channel: string,
): DeliveryRule | undefined =>
  rulesFor(options, type).find((rule) => rule.channel === channel);

/**
 * Records that the user is in the app. Called from the endpoints the inbox
 * polls; writes at most once a minute per user.
 */
export async function touchPresence(
  context: AuthContext,
  userId: string,
  now = new Date(),
) {
  const find = () =>
    context.adapter.findOne<InboxPresence>({
      model: "inboxPresence",
      where: [{ field: "userId", value: userId }],
    });
  let existing = await find();
  if (!existing) {
    try {
      await context.adapter.create({
        model: "inboxPresence",
        data: { userId, lastSeenAt: now },
      });
      return;
    } catch (error) {
      // a concurrent first write won the unique row: update it instead
      existing = await find();
      if (!existing) throw error;
    }
  }
  if (
    now.getTime() - new Date(existing.lastSeenAt).getTime() >=
    PRESENCE_WRITE_INTERVAL
  ) {
    // lt keeps a stale write from moving lastSeenAt backwards
    await context.adapter.update({
      model: "inboxPresence",
      where: [
        { field: "id", value: existing.id },
        { field: "lastSeenAt", operator: "lt", value: now },
      ],
      update: { lastSeenAt: now },
    });
  }
}

async function presentUserIds(
  adapter: DBTransactionAdapter,
  userIds: string[],
  options: ResolvedDeliveryOptions,
  now: Date,
) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await findManyIn<InboxPresence>(adapter, {
    model: "inboxPresence",
    field: "userId",
    values: userIds,
    where: [
      {
        field: "lastSeenAt",
        operator: "gte",
        value: new Date(now.getTime() - options.presenceWindow),
      },
    ],
  });
  return new Set(rows.map((row) => row.userId));
}

/**
 * Writes the delivery rows for freshly created notifications, through `adapter`
 * (the caller's transaction, when there is one). Rows due now are attempted in
 * the background when better-auth has a background task handler and the batch
 * is small; everything else waits for `processDeliveries`. Inside a transaction
 * nothing is attempted here: the rows aren't committed yet, and the sweep sends
 * them once the transaction is.
 */
export async function scheduleDeliveries(
  context: AuthContext,
  adapter: DBTransactionAdapter,
  notifications: Notification[],
  options: ResolvedDeliveryOptions,
) {
  const first = notifications[0];
  if (!first || !hasChannels(options)) return;
  // one notify call shares a type, so one rule set covers every row
  const rules = rulesFor(options, first.type);
  if (rules.length === 0) return;

  const now = new Date();
  const present = rules.some(
    (rule) => rule.ifUnreadAfter && rule.sendNowIfAway !== false,
  )
    ? await presentUserIds(
        adapter,
        [...new Set(notifications.map((n) => n.userId))],
        options,
        now,
      )
    : new Set<string>();

  const dueNow: NotificationDelivery[] = [];
  for (const notification of notifications) {
    for (const rule of rules) {
      const away = !present.has(notification.userId);
      const sendNow =
        !rule.ifUnreadAfter || (rule.sendNowIfAway !== false && away);
      const scheduledFor = sendNow
        ? now
        : new Date(now.getTime() + durationMs(rule.ifUnreadAfter!));
      const delivery = await adapter.create<
        Omit<NotificationDelivery, "id">,
        NotificationDelivery
      >({
        model: "notificationDelivery",
        data: {
          notificationId: notification.id,
          userId: notification.userId,
          type: notification.type,
          channel: rule.channel,
          status: "pending",
          scheduledFor,
          attempts: 0,
          createdAt: now,
        },
      });
      if (sendNow) dueNow.push(delivery);
    }
  }

  // without a handler runInBackgroundOrAwait awaits, which would hold notify
  // open for every send; the sweep picks these up instead
  const inTransaction = adapter !== context.adapter;
  if (
    !inTransaction &&
    dueNow.length > 0 &&
    dueNow.length <= options.immediateLimit &&
    context.options.advanced?.backgroundTasks?.handler
  ) {
    await context.runInBackgroundOrAwait(
      attemptDeliveries(context, dueNow, options),
    );
  }
}

export type SweepResult = {
  sent: number;
  skipped: number;
  retrying: number;
  failed: number;
  /**
   * Call again: more deliveries were due than the batch size, or the sweep
   * stopped at `limit` stale sends with no attempts left after failing at
   * least one on the capped page. So it can be true with nothing due to send.
   */
  hasMore: boolean;
};

/** One sweep: reclaim stale leases, then attempt a batch of due deliveries. */
export async function processDueDeliveries(
  context: AuthContext,
  options: ResolvedDeliveryOptions,
  limit = options.batchSize,
): Promise<SweepResult> {
  const now = new Date();
  // A worker that died mid-send leaves its row in "sending". Release it first
  // so the claim below can stay a plain AND guard on status, unless it has
  // used up its attempts: a send that keeps getting killed would loop forever.
  const stale: Where[] = [
    { field: "status", value: "sending" },
    {
      field: "claimedAt",
      operator: "lt",
      value: new Date(now.getTime() - options.leaseMs),
    },
  ];
  const staleCapped = await failExhaustedLeases(context, options, stale, limit);
  // guarded: an exhausted row the loop above didn't reach (the limit cap)
  // stays "sending" for the next sweep instead of being retried past maxAttempts
  await context.adapter.updateMany({
    model: "notificationDelivery",
    where: [
      ...stale,
      { field: "attempts", operator: "lt", value: options.maxAttempts },
    ],
    update: { status: "pending" },
  });

  const due = await context.adapter.findMany<NotificationDelivery>({
    model: "notificationDelivery",
    where: [
      { field: "status", value: "pending" },
      { field: "scheduledFor", operator: "lte", value: now },
    ],
    sortBy: { field: "scheduledFor", direction: "asc" },
    limit: limit + 1,
  });
  const result = await attemptDeliveries(context, due.slice(0, limit), options);
  return { ...result, hasMore: due.length > limit || staleCapped };
}

/**
 * Marks stale leases that have used up their attempts as failed, one row at a
 * time, and emits `notifications.delivery.failed` (`"unfinished"`) for each.
 * The per-row guarded update is the compare-and-swap: of two overlapping
 * sweeps, exactly one moves (and reports) a row. Examines at most `limit` rows;
 * returns true only when it stopped at that cap with rows left after moving at
 * least one on the capped page, so the sweep reports `hasMore`. Rows it can't
 * move (row-level security, or another sweep took them) are left out of later
 * pages in the same sweep, but they still count against `limit`: once `limit`
 * of them (up to 180, IN_CHUNK twice over) come first in scan order, later
 * exhausted rows wait.
 */
async function failExhaustedLeases(
  context: AuthContext,
  options: ResolvedDeliveryOptions,
  stale: Where[],
  limit: number,
): Promise<boolean> {
  const exhausted: Where[] = [
    ...stale,
    { field: "attempts", operator: "gte", value: options.maxAttempts },
  ];
  // ids whose guarded update moved nothing; capped at IN_CHUNK so the
  // not_in list stays within D1's 100 parameters
  const stuck: string[] = [];
  let examined = 0;
  while (examined < limit) {
    const take = Math.min(IN_CHUNK, limit - examined);
    const page = await context.adapter.findMany<NotificationDelivery>({
      model: "notificationDelivery",
      where:
        stuck.length > 0
          ? [...exhausted, { field: "id", operator: "not_in", value: stuck }]
          : exhausted,
      limit: take + 1,
    });
    if (page.length === 0) return false;
    const rows = page.slice(0, take);
    // defense in depth: a take of zero (a non-integer limit) must not spin
    if (rows.length === 0) return false;
    examined += rows.length;
    const capped = page.length > take && examined >= limit;

    const organizationIds = options.onEvent
      ? new Map(
          (
            await findManyIn<Notification>(context.adapter, {
              model: "notification",
              field: "id",
              values: rows.map((row) => row.notificationId),
            })
          ).map((n) => [n.id, n.organizationId]),
        )
      : undefined;

    let moved = 0;
    let unrecorded = false;
    for (const row of rows) {
      const updated = await context.adapter.updateMany({
        model: "notificationDelivery",
        where: [{ field: "id", value: row.id }, ...exhausted],
        update: { status: "failed", detail: "send did not finish" },
      });
      if (updated !== 1) {
        if (stuck.length < IN_CHUNK) stuck.push(row.id);
        else unrecorded = true;
        continue;
      }
      moved++;
      await emit(
        options.onEvent,
        context,
        context.adapter,
        deliveryFailed(row, {
          organizationId: organizationIds?.get(row.notificationId),
          attempts: row.attempts,
          reason: "unfinished",
        }),
      );
    }
    // don't report hasMore for a capped page this sweep couldn't move
    if (capped) return moved > 0;
    if (page.length <= take) return false;
    // nothing moved, and some of it couldn't be excluded: the next page would
    // come back the same, so stop rather than spin
    if (moved === 0 && unrecorded) return false;
  }
  return false;
}

const CONCURRENCY = 10;

async function attemptDeliveries(
  context: AuthContext,
  deliveries: NotificationDelivery[],
  options: ResolvedDeliveryOptions,
) {
  const result = { sent: 0, skipped: 0, retrying: 0, failed: 0 };
  if (deliveries.length === 0) return result;

  // batchSize may exceed findMany's default 100 rows and D1's 100 parameters
  const [notifications, users] = await Promise.all([
    findManyIn<Notification>(context.adapter, {
      model: "notification",
      field: "id",
      values: deliveries.map((d) => d.notificationId),
    }),
    findManyIn<User>(context.adapter, {
      model: "user",
      field: "id",
      values: deliveries.map((d) => d.userId),
    }),
  ]);
  const notificationsById = new Map(notifications.map((n) => [n.id, n]));
  const usersById = new Map(users.map((u) => [u.id, u]));

  // A throttle check reads the last send for (user, type, channel), so two
  // rows with the same key must not run side by side or both would pass it.
  // Groups run in parallel; each group runs in order.
  const groups = new Map<string, NotificationDelivery[]>();
  for (const delivery of deliveries) {
    const key = `${delivery.userId}|${delivery.type}|${delivery.channel}`;
    const group = groups.get(key);
    if (group) group.push(delivery);
    else groups.set(key, [delivery]);
  }
  const queue = [...groups.values()];
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    await Promise.all(
      queue.slice(i, i + CONCURRENCY).map(async (group) => {
        for (const delivery of group) {
          const outcome = await attemptDelivery(
            context,
            delivery,
            notificationsById.get(delivery.notificationId),
            usersById.get(delivery.userId),
            options,
          );
          if (outcome) result[outcome]++;
        }
      }),
    );
  }
  return result;
}

async function attemptDelivery(
  context: AuthContext,
  delivery: NotificationDelivery,
  notification: Notification | undefined,
  user: User | undefined,
  options: ResolvedDeliveryOptions,
): Promise<"sent" | "skipped" | "retrying" | "failed" | null> {
  const now = new Date();
  // The immediate path and a sweep can both hold this row. incrementOne is the
  // adapter's compare-and-swap: exactly one caller gets it back.
  const claimed = await context.adapter.incrementOne<NotificationDelivery>({
    model: "notificationDelivery",
    where: [
      { field: "id", value: delivery.id },
      { field: "status", value: "pending" },
      { field: "scheduledFor", operator: "lte", value: now },
    ],
    increment: { attempts: 1 },
    set: { status: "sending", claimedAt: now },
  });
  if (!claimed) return null;

  const finish = (update: Partial<NotificationDelivery>) =>
    context.adapter.update({
      model: "notificationDelivery",
      where: [{ field: "id", value: delivery.id }],
      update,
    });
  const skip = async (detail: string) => {
    await finish({ status: "skipped", detail });
    return "skipped" as const;
  };

  const channel = options.channels[delivery.channel];
  if (!channel) return skip("unknown channel");
  if (!notification) return skip("notification deleted");
  const rule = ruleFor(options, delivery.type, delivery.channel);
  if (rule?.cancelIfRead !== false) {
    if (notification.read) return skip("read");
    if (notification.seenAt) return skip("seen");
  }
  if (!user) return skip("user deleted");
  if (rule?.throttle) {
    const recent = await context.adapter.findOne<NotificationDelivery>({
      model: "notificationDelivery",
      where: [
        { field: "userId", value: delivery.userId },
        { field: "type", value: delivery.type },
        { field: "channel", value: delivery.channel },
        { field: "status", value: "sent" },
        {
          field: "sentAt",
          operator: "gt",
          value: new Date(now.getTime() - durationMs(rule.throttle)),
        },
      ],
    });
    if (recent) return skip("throttled");
  }
  if (
    options.shouldDeliver &&
    !(await options.shouldDeliver({
      notification,
      user,
      channel: delivery.channel,
    }))
  ) {
    return skip("opted out");
  }

  try {
    await channel.deliver({ notification, user, appUrl: options.appUrl });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.logger.error(
      `[@byo-oss/notifications] ${delivery.channel} delivery ${delivery.id} failed: ${detail}`,
    );
    const permanent = isPermanent(error);
    if (permanent || claimed.attempts >= options.maxAttempts) {
      await finish({ status: "failed", detail });
      await emit(
        options.onEvent,
        context,
        context.adapter,
        deliveryFailed(delivery, {
          organizationId: notification.organizationId,
          attempts: claimed.attempts,
          reason: permanent ? "permanent" : "max_attempts",
        }),
      );
      return "failed";
    }
    const backoff = Math.min(
      BACKOFF_BASE * 2 ** (claimed.attempts - 1),
      BACKOFF_MAX,
    );
    await finish({
      status: "pending",
      scheduledFor: new Date(Date.now() + backoff),
      detail,
    });
    return "retrying";
  }
  await finish({ status: "sent", sentAt: new Date(), detail: null });
  return "sent";
}
