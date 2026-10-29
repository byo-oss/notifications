import { type AuthContext, getCurrentAdapter, type Where } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { chunk } from "./adapter";
import {
  hasChannels,
  processDueDeliveries,
  type ResolvedDeliveryOptions,
  scheduleDeliveries,
  touchPresence,
} from "./delivery";
import { INBOX_ERROR_CODES } from "./error-codes";
import { emit, notificationCreated } from "./events";
import type { Notification } from "./schema";

// the plugin's own event types; a notification of one could feed an onEvent
// that forwards events into notify back into itself
const RESERVED_TYPE_PREFIX = "notifications.";

export type ResolvedInboxOptions = ResolvedDeliveryOptions & {
  maxFanout: number;
};

const notifyBodySchema = z
  .object({
    userId: z.string().optional(),
    organizationId: z.string().optional(),
    roles: z.array(z.string()).optional(),
    excludeUserIds: z.array(z.string()).optional(),
    type: z.string(),
    title: z.string(),
    body: z.string().optional(),
    href: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => !!body.userId || !!body.organizationId, {
    message: INBOX_ERROR_CODES.USER_OR_ORGANIZATION_REQUIRED.message,
  })
  .refine(
    (body) =>
      !body.userId ||
      (body.roles === undefined && body.excludeUserIds === undefined),
    { message: INBOX_ERROR_CODES.FAN_OUT_OPTIONS_WITHOUT_USER.message },
  );

/**
 * Creates the notifications and their delivery rows. Inside a better-auth
 * transaction (`runWithTransaction`) they join it and commit or roll back with
 * it, and no email goes out until the transaction has committed: the next
 * `processDeliveries` sweep sends it. `notifications.notification.created`
 * fires per row once the rows have committed: before this returns outside a
 * transaction, after the commit inside one, never on rollback.
 */
export const notify = (options: ResolvedInboxOptions) =>
  createAuthEndpoint.serverOnly(
    {
      method: "POST",
      body: notifyBodySchema,
    },
    async (ctx) => {
      const { userId, organizationId, roles, excludeUserIds, ...payload } =
        ctx.body;
      if (payload.type.startsWith(RESERVED_TYPE_PREFIX)) {
        throw APIError.from(
          "BAD_REQUEST",
          INBOX_ERROR_CODES.RESERVED_NOTIFICATION_TYPE,
        );
      }
      // the caller's transaction when notify runs inside runWithTransaction, so
      // these rows commit or roll back with it; resolved once, used throughout
      const adapter = await getCurrentAdapter(ctx.context.adapter);

      const created = async (notifications: Notification[]) => {
        await scheduleDeliveries(ctx.context, adapter, notifications, options);
        // one event per row, held until the caller's transaction commits
        for (const notification of notifications) {
          await emit(
            options.onEvent,
            ctx.context,
            adapter,
            notificationCreated(notification),
          );
        }
        return { count: notifications.length, notifications };
      };

      const createFor = (targetUserId: string) =>
        adapter.create<Omit<Notification, "id">, Notification>({
          model: "notification",
          data: {
            userId: targetUserId,
            ...(organizationId ? { organizationId } : {}),
            ...payload,
            read: false,
            createdAt: new Date(),
          },
        });

      if (!organizationId) {
        return created([await createFor(userId!)]);
      }

      const hasOrgPlugin = ctx.context.options.plugins?.some(
        (plugin) => plugin.id === "organization",
      );
      if (!hasOrgPlugin) {
        throw APIError.from(
          "BAD_REQUEST",
          INBOX_ERROR_CODES.ORGANIZATION_PLUGIN_REQUIRED,
        );
      }

      if (userId) {
        const membership = await adapter.findOne<{ id: string }>({
          model: "member",
          where: [
            { field: "userId", value: userId },
            { field: "organizationId", value: organizationId },
          ],
        });
        if (!membership) {
          throw APIError.from(
            "BAD_REQUEST",
            INBOX_ERROR_CODES.USER_NOT_IN_ORGANIZATION,
          );
        }
        return created([await createFor(userId)]);
      }

      const members = await adapter.findMany<{
        userId: string;
        role: string;
      }>({
        model: "member",
        where: [{ field: "organizationId", value: organizationId }],
        limit: options.maxFanout + 1,
      });
      if (members.length === 0) {
        throw APIError.from(
          "BAD_REQUEST",
          INBOX_ERROR_CODES.ORGANIZATION_HAS_NO_MEMBERS,
        );
      }
      if (members.length > options.maxFanout) {
        throw APIError.from(
          "BAD_REQUEST",
          INBOX_ERROR_CODES.FAN_OUT_LIMIT_EXCEEDED,
        );
      }

      const excluded = new Set(excludeUserIds ?? []);
      const targets = members.filter(
        (member) =>
          !excluded.has(member.userId) &&
          (!roles?.length ||
            member.role.split(",").some((role) => roles.includes(role))),
      );

      const notifications: Notification[] = [];
      for (const member of targets) {
        notifications.push(await createFor(member.userId));
      }
      return created(notifications);
    },
  );

export const processDeliveries = (options: ResolvedInboxOptions) =>
  createAuthEndpoint.serverOnly(
    {
      method: "POST",
      body: z
        .object({ limit: z.number().int().min(1).max(1000).optional() })
        .optional(),
    },
    async (ctx) => processDueDeliveries(ctx.context, options, ctx.body?.limit),
  );

// The inbox polls unread-count while the tab is visible and on every refresh,
// which makes it the presence heartbeat for "send now if the user is away".
// two overlapping first heartbeats can race to create the same unique row;
// touchPresence tolerates that.
async function heartbeat(
  context: AuthContext & {
    session: {
      user: { id: string };
      session: { impersonatedBy?: string | null };
    };
  },
  options: ResolvedInboxOptions,
) {
  if (!hasChannels(options)) return;
  // an admin impersonating the user (admin plugin) is not the user being around
  if (context.session.session.impersonatedBy) return;
  try {
    await touchPresence(context, context.session.user.id);
  } catch (error) {
    context.logger.error("[@byo-oss/notifications] failed to record presence", error);
  }
}

const listQuerySchema = z
  .object({
    filter: z.enum(["unread", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    organizationId: z.string().optional(),
  })
  .optional();

export const listNotifications = () =>
  createAuthEndpoint(
    "/inbox/list",
    {
      method: "GET",
      query: listQuerySchema,
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { filter = "all", limit = 20, offset = 0, organizationId } =
        ctx.query ?? {};
      const where: Where[] = [
        { field: "userId", value: ctx.context.session.user.id },
      ];
      if (filter === "unread") {
        where.push({ field: "read", value: false });
      }
      if (organizationId) {
        where.push({ field: "organizationId", value: organizationId });
      }
      const rows = await ctx.context.adapter.findMany<Notification>({
        model: "notification",
        where,
        limit: limit + 1,
        offset,
        sortBy: { field: "createdAt", direction: "desc" },
      });
      return {
        notifications: rows.slice(0, limit),
        hasMore: rows.length > limit,
      };
    },
  );

export const markRead = () =>
  createAuthEndpoint(
    "/inbox/mark-read",
    {
      method: "POST",
      body: z.object({ id: z.string() }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const updated = await ctx.context.adapter.update<Notification>({
        model: "notification",
        where: [
          { field: "id", value: ctx.body.id },
          { field: "userId", value: ctx.context.session.user.id },
        ],
        update: { read: true },
      });
      if (!updated) {
        throw APIError.from(
          "NOT_FOUND",
          INBOX_ERROR_CODES.NOTIFICATION_NOT_FOUND,
        );
      }
      return { notification: updated };
    },
  );

export const markSeen = () =>
  createAuthEndpoint(
    "/inbox/mark-seen",
    {
      method: "POST",
      body: z.object({ ids: z.array(z.string()).min(1).max(100) }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const seenAt = new Date();
      let count = 0;
      // chunked: 100 ids plus the other parameters exceed D1's 100 per query
      for (const ids of chunk(ctx.body.ids)) {
        count += await ctx.context.adapter.updateMany({
          model: "notification",
          where: [
            { field: "userId", value: ctx.context.session.user.id },
            { field: "id", operator: "in", value: ids },
          ],
          update: { seenAt },
        });
      }
      return { count };
    },
  );

export const markAllRead = () =>
  createAuthEndpoint(
    "/inbox/mark-all-read",
    {
      method: "POST",
      body: z.object({ organizationId: z.string().optional() }),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const where: Where[] = [
        { field: "userId", value: ctx.context.session.user.id },
        { field: "read", value: false },
      ];
      if (ctx.body.organizationId) {
        where.push({ field: "organizationId", value: ctx.body.organizationId });
      }
      const count = await ctx.context.adapter.updateMany({
        model: "notification",
        where,
        update: { read: true },
      });
      return { count };
    },
  );

export const unreadCount = (options: ResolvedInboxOptions) =>
  createAuthEndpoint(
    "/inbox/unread-count",
    {
      method: "GET",
      query: z.object({ organizationId: z.string().optional() }).optional(),
      use: [sessionMiddleware],
    },
    async (ctx) => {
      await heartbeat(ctx.context, options);
      const where: Where[] = [
        { field: "userId", value: ctx.context.session.user.id },
        { field: "read", value: false },
      ];
      if (ctx.query?.organizationId) {
        where.push({
          field: "organizationId",
          value: ctx.query.organizationId,
        });
      }
      const count = await ctx.context.adapter.count({
        model: "notification",
        where,
      });
      return { count };
    },
  );
