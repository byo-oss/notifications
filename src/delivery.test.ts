import { runWithTransaction } from "@better-auth/core/context";
import type { AuthContext } from "better-auth";
import { admin } from "better-auth/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeliveryContext,
  type InboxChannel,
  touchPresence,
} from "./delivery";
import { inbox, type InboxOptions, PermanentDeliveryError } from "./index";
import type { NotificationDelivery } from "./schema";
import {
  createTestAuth,
  createTestAuthWithOrg,
  signUpUser,
} from "./test-utils";

const MINUTE = 60_000;

function fakeChannel() {
  const sent: DeliveryContext[] = [];
  const channel = {
    deliver: vi.fn(async (ctx: DeliveryContext) => {
      sent.push(ctx);
    }),
  } satisfies InboxChannel;
  return { channel, sent };
}

function emailAfter15(extra: Partial<InboxOptions> = {}) {
  const email = fakeChannel();
  const options = {
    appUrl: "https://app.acme.test",
    channels: { email: email.channel },
    routes: {
      "billing.payment_failed": [
        { channel: "email", ifUnreadAfter: { minutes: 15 } },
      ],
    },
    ...extra,
  } satisfies InboxOptions;
  return { email, options };
}

async function deliveries(auth: { $context: Promise<any> }) {
  const ctx = await auth.$context;
  return ctx.adapter.findMany({
    model: "notificationDelivery",
  }) as Promise<NotificationDelivery[]>;
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  // only Date: better-auth and the memory adapter still need real timers
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("email if unread", () => {
  it("sends on the first sweep when the user is not in the app", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");

    await auth.api.notify({
      body: {
        userId: alice.user.id,
        type: "billing.payment_failed",
        title: "Payment failed",
        href: "/settings/billing",
      },
    });
    // no background task handler, so notify leaves the send to the sweep
    expect(email.sent).toHaveLength(0);

    const res = await auth.api.processDeliveries({});
    expect(res).toMatchObject({ sent: 1, skipped: 0, hasMore: false });
    expect(email.sent[0]).toMatchObject({
      user: { email: "alice@example.com" },
      notification: { title: "Payment failed", href: "/settings/billing" },
      appUrl: "https://app.acme.test",
    });
    expect(await deliveries(auth)).toMatchObject([
      { status: "sent", attempts: 1, channel: "email" },
    ]);
  });

  it("waits 15 minutes when the user is in the app", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.unreadCount({ headers: alice.headers, query: {} });

    await auth.api.notify({
      body: {
        userId: alice.user.id,
        type: "billing.payment_failed",
        title: "Payment failed",
      },
    });

    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
    advance(14 * MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
    advance(1 * MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
  });

  it("treats a user whose last poll is older than the presence window as away", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    advance(3 * MINUTE);

    await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
  });

  it("skips the email when the notification is read first", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.unreadCount({ headers: alice.headers, query: {} });

    const { notifications } = await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });
    advance(5 * MINUTE);
    await auth.api.markRead({
      headers: alice.headers,
      body: { id: notifications[0]!.id },
    });
    advance(10 * MINUTE);

    expect(await auth.api.processDeliveries({})).toMatchObject({
      sent: 0,
      skipped: 1,
    });
    expect(email.sent).toHaveLength(0);
    expect(await deliveries(auth)).toMatchObject([
      { status: "skipped", detail: "read" },
    ]);
  });

  it("skips the email when the notification is seen first", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.unreadCount({ headers: alice.headers, query: {} });

    const { notifications } = await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });
    await auth.api.markSeen({
      headers: alice.headers,
      body: { ids: [notifications[0]!.id] },
    });
    advance(15 * MINUTE);

    expect(await auth.api.processDeliveries({})).toMatchObject({ skipped: 1 });
    expect(email.sent).toHaveLength(0);
    expect(await deliveries(auth)).toMatchObject([
      { status: "skipped", detail: "seen" },
    ]);
  });

  it("leaves types without a route in-app only, and falls back to \"*\"", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: { "security.new_login": [{ channel: "email" }] },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "comment.reply", title: "x" },
    });
    expect(await deliveries(auth)).toHaveLength(0);

    const withFallback = createTestAuth({
      channels: { email: email.channel },
      routes: { "*": [{ channel: "email" }] },
    });
    const bob = await signUpUser(withFallback, "bob@example.com");
    await withFallback.api.notify({
      body: { userId: bob.user.id, type: "comment.reply", title: "x" },
    });
    expect(await deliveries(withFallback)).toHaveLength(1);
  });

  it("sends right away, even to a present user, when the rule has no delay", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: { "security.new_login": [{ channel: "email" }] },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    await auth.api.notify({
      body: { userId: alice.user.id, type: "security.new_login", title: "x" },
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
  });

  it("waits for an away user too when sendNowIfAway is false", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: {
        digestable: [
          { channel: "email", ifUnreadAfter: { minutes: 15 }, sendNowIfAway: false },
        ],
      },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "digestable", title: "x" },
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
    advance(15 * MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
  });

  it("skips deliveries shouldDeliver rejects", async () => {
    const shouldDeliver = vi.fn(() => false);
    const { email, options } = emailAfter15({ shouldDeliver });
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });

    expect(await auth.api.processDeliveries({})).toMatchObject({ skipped: 1 });
    expect(email.sent).toHaveLength(0);
    expect(shouldDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        user: expect.objectContaining({ id: alice.user.id }),
      }),
    );
    expect(await deliveries(auth)).toMatchObject([
      { status: "skipped", detail: "opted out" },
    ]);
  });

  it("sends inside notify when better-auth has a background task handler", async () => {
    const tasks: Promise<unknown>[] = [];
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options, {
      advanced: { backgroundTasks: { handler: (p) => void tasks.push(p) } },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    tasks.length = 0;

    await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });
    await Promise.all(tasks);
    expect(email.sent).toHaveLength(1);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
  });
});

describe("cancelIfRead and throttle", () => {
  it("sends a cancelIfRead: false email even after the notification was read", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: {
        "account.password_changed": [{ channel: "email", cancelIfRead: false }],
      },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    const { notifications } = await auth.api.notify({
      body: { userId: alice.user.id, type: "account.password_changed", title: "x" },
    });
    await auth.api.markRead({
      headers: alice.headers,
      body: { id: notifications[0]!.id },
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
  });

  it("still honors shouldDeliver with cancelIfRead: false", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: { x: [{ channel: "email", cancelIfRead: false }] },
      shouldDeliver: () => false,
    });
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({ body: { userId: alice.user.id, type: "x", title: "x" } });
    expect(await auth.api.processDeliveries({})).toMatchObject({ skipped: 1 });
  });

  it("sends one email per throttle window, even for rows in the same sweep", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: { "run.failed": [{ channel: "email", throttle: { hours: 1 } }] },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    const bob = await signUpUser(auth, "bob@example.com");
    for (const title of ["a", "b", "c"]) {
      await auth.api.notify({
        body: { userId: alice.user.id, type: "run.failed", title },
      });
    }
    // another user's throttle is separate
    await auth.api.notify({
      body: { userId: bob.user.id, type: "run.failed", title: "d" },
    });

    expect(await auth.api.processDeliveries({})).toMatchObject({
      sent: 2,
      skipped: 2,
    });
    expect(email.sent.map((s) => s.notification.title).sort()).toEqual(["a", "d"]);
    expect(
      (await deliveries(auth)).filter((d) => d.detail === "throttled"),
    ).toHaveLength(2);

    advance(59 * MINUTE);
    await auth.api.notify({
      body: { userId: alice.user.id, type: "run.failed", title: "e" },
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({ skipped: 1 });
    advance(1 * MINUTE);
    await auth.api.notify({
      body: { userId: alice.user.id, type: "run.failed", title: "f" },
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
  });

  it("does not count a skipped delivery toward the throttle", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: { x: [{ channel: "email", throttle: { hours: 1 } }] },
    });
    const alice = await signUpUser(auth, "alice@example.com");
    const first = await auth.api.notify({
      body: { userId: alice.user.id, type: "x", title: "a" },
    });
    await auth.api.markRead({
      headers: alice.headers,
      body: { id: first.notifications[0]!.id },
    });
    await auth.api.notify({ body: { userId: alice.user.id, type: "x", title: "b" } });
    expect(await auth.api.processDeliveries({})).toMatchObject({
      sent: 1,
      skipped: 1,
    });
    expect(email.sent[0]!.notification.title).toBe("b");
  });
});

describe("processDeliveries", () => {
  it("sends once when sweeps overlap", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });

    const results = await Promise.all([
      auth.api.processDeliveries({}),
      auth.api.processDeliveries({}),
    ]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
    expect(email.sent).toHaveLength(1);
  });

  it("retries a throwing channel with backoff, then marks it failed", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("SES throttled");
    });
    const auth = createTestAuth({
      channels: { email: { deliver } },
      routes: { "*": [{ channel: "email" }] },
      maxAttempts: 2,
    });
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "x", title: "x" },
    });

    expect(await auth.api.processDeliveries({})).toMatchObject({ retrying: 1 });
    const [retry] = await deliveries(auth);
    expect(retry).toMatchObject({
      status: "pending",
      attempts: 1,
      detail: "SES throttled",
    });
    expect(new Date(retry!.scheduledFor).getTime()).toBe(Date.now() + MINUTE);

    expect(await auth.api.processDeliveries({})).toMatchObject({ retrying: 0 });
    advance(MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ failed: 1 });
    expect(await deliveries(auth)).toMatchObject([
      { status: "failed", attempts: 2, detail: "SES throttled" },
    ]);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("fails a permanent error at once instead of retrying", async () => {
    for (const error of [
      new PermanentDeliveryError("address does not exist"),
      Object.assign(new Error("hard bounce"), { permanent: true }),
    ]) {
      const auth = createTestAuth({
        channels: {
          email: {
            deliver: async () => {
              throw error;
            },
          },
        },
        routes: { "*": [{ channel: "email" }] },
      });
      const alice = await signUpUser(auth, "alice@example.com");
      await auth.api.notify({
        body: { userId: alice.user.id, type: "x", title: "Hi" },
      });

      expect(await auth.api.processDeliveries({})).toMatchObject({
        failed: 1,
        retrying: 0,
      });
      expect(await deliveries(auth)).toMatchObject([
        { status: "failed", attempts: 1, detail: error.message },
      ]);
    }
  });

  it("reclaims a delivery whose worker died mid-send", async () => {
    const { email, options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });
    const ctx = await auth.$context;
    const [row] = await deliveries(auth);
    await ctx.adapter.update({
      model: "notificationDelivery",
      where: [{ field: "id", value: row!.id }],
      update: { status: "sending", claimedAt: new Date(), attempts: 1 },
    });

    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
    advance(6 * MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
    expect(await deliveries(auth)).toMatchObject([
      { status: "sent", attempts: 2 },
    ]);
  });

  it("fails a delivery whose sends keep dying once attempts run out", async () => {
    const { email, options } = emailAfter15({ maxAttempts: 2 });
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.notify({
      body: { userId: alice.user.id, type: "billing.payment_failed", title: "x" },
    });
    const ctx = await auth.$context;
    const [row] = await deliveries(auth);
    await ctx.adapter.update({
      model: "notificationDelivery",
      where: [{ field: "id", value: row!.id }],
      update: { status: "sending", claimedAt: new Date(), attempts: 2 },
    });

    advance(6 * MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
    expect(email.sent).toHaveLength(0);
    expect(await deliveries(auth)).toMatchObject([
      { status: "failed", detail: "send did not finish" },
    ]);
  });

  it("works through an org fan-out across batches", async () => {
    const { email, options } = emailAfter15({ batchSize: 2 });
    const auth = createTestAuthWithOrg(options);
    const alice = await signUpUser(auth, "alice@example.com");
    const bob = await signUpUser(auth, "bob@example.com");
    const carol = await signUpUser(auth, "carol@example.com");
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: "Acme", slug: "acme" },
    });
    for (const user of [bob, carol]) {
      await auth.api.addMember({
        body: { userId: user.user.id, organizationId: org!.id, role: "member" },
      });
    }
    // carol is in the app, so hers waits
    await auth.api.unreadCount({ headers: carol.headers, query: {} });

    await auth.api.notify({
      body: {
        organizationId: org!.id,
        type: "billing.payment_failed",
        title: "Payment failed",
      },
    });

    expect(await auth.api.processDeliveries({})).toMatchObject({
      sent: 2,
      hasMore: false,
    });
    expect(email.sent.map((s) => s.user.email).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    advance(15 * MINUTE);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
  });

  // the adapter's findMany returns 100 rows unless told otherwise
  describe("past 100 rows", () => {
    async function bigOrg(options: InboxOptions, size: number) {
      const auth = createTestAuthWithOrg(options);
      const { adapter } = await auth.$context;
      const org = await adapter.create<any, { id: string }>({
        model: "organization",
        data: { name: "Big", slug: "big", createdAt: new Date() },
      });
      for (let i = 0; i < size; i++) {
        const user = await adapter.create<any, { id: string }>({
          model: "user",
          data: {
            name: `u${i}`,
            email: `u${i}@example.com`,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        await adapter.create({
          model: "member",
          data: {
            organizationId: org.id,
            userId: user.id,
            role: "member",
            createdAt: new Date(),
          },
        });
        await adapter.create({
          model: "inboxPresence",
          data: { userId: user.id, lastSeenAt: new Date() },
        });
      }
      return { auth, org };
    }

    it("holds the email for every present member of a large org", async () => {
      const { options } = emailAfter15();
      const { auth, org } = await bigOrg(options, 120);

      await auth.api.notify({
        body: {
          organizationId: org.id,
          type: "billing.payment_failed",
          title: "Payment failed",
        },
      });

      const rows = await (await auth.$context).adapter.findMany<any>({
        model: "notificationDelivery",
        limit: 1000,
      });
      expect(rows).toHaveLength(120);
      expect(
        rows.filter((d) => new Date(d.scheduledFor).getTime() <= Date.now()),
      ).toEqual([]);
    });

    it("sends a batch larger than 100 in one sweep", async () => {
      const email = fakeChannel();
      const { auth, org } = await bigOrg(
        {
          channels: { email: email.channel },
          routes: { "*": [{ channel: "email" }] },
          batchSize: 150,
        },
        120,
      );

      await auth.api.notify({
        body: { organizationId: org.id, type: "x", title: "Hello" },
      });

      expect(await auth.api.processDeliveries({})).toMatchObject({
        sent: 120,
        hasMore: false,
      });
      expect(new Set(email.sent.map((s) => s.user.email)).size).toBe(120);
    });
  });

  it("reports hasMore when more deliveries are due than the batch holds", async () => {
    const email = fakeChannel();
    const auth = createTestAuth({
      channels: { email: email.channel },
      routes: { "*": [{ channel: "email" }] },
      batchSize: 2,
    });
    const alice = await signUpUser(auth, "alice@example.com");
    for (const title of ["a", "b", "c"]) {
      await auth.api.notify({
        body: { userId: alice.user.id, type: "x", title },
      });
    }
    expect(await auth.api.processDeliveries({})).toMatchObject({
      sent: 2,
      hasMore: true,
    });
    expect(await auth.api.processDeliveries({})).toMatchObject({
      sent: 1,
      hasMore: false,
    });
  });
});

describe("markSeen", () => {
  it("only marks the caller's own notifications", async () => {
    const auth = createTestAuth();
    const alice = await signUpUser(auth, "alice@example.com");
    const bob = await signUpUser(auth, "bob@example.com");
    const { notifications } = await auth.api.notify({
      body: { userId: alice.user.id, type: "x", title: "x" },
    });

    const res = await auth.api.markSeen({
      headers: bob.headers,
      body: { ids: [notifications[0]!.id] },
    });
    expect(res.count).toBe(0);
    const list = await auth.api.listNotifications({
      headers: alice.headers,
      query: {},
    });
    expect(list.notifications[0]!.seenAt ?? null).toBeNull();
  });
});

describe("options", () => {
  it("type-checks routes against the configured channel names", () => {
    const email = fakeChannel().channel;
    // the README shape, inline, so the channel names infer as literals
    inbox({
      channels: { email },
      routes: {
        "billing.payment_failed": [
          { channel: "email", ifUnreadAfter: { minutes: 15 } },
        ],
      },
    });
    expect(() =>
      inbox({
        channels: { email },
        // @ts-expect-error "sms" is not a configured channel
        routes: { x: [{ channel: "sms" }] },
      }),
    ).toThrow(/channel "sms"/);
  });

  it("returns one plugin type whatever the channels are called", () => {
    const configured = inbox({
      channels: { email: fakeChannel().channel },
      routes: { x: [{ channel: "email" }] },
    });
    const plain: ReturnType<typeof inbox> = configured;
    expect(plain.id).toBe("inbox");
  });

  it("rejects a route that names an unknown channel", () => {
    expect(() =>
      inbox({
        channels: {},
        routes: { x: [{ channel: "sms" as never }] },
      }),
    ).toThrow(/channel "sms"/);
  });

  it("records presence from unread-count only, at most once a minute", async () => {
    const { options } = emailAfter15();
    const auth = createTestAuth(options);
    const alice = await signUpUser(auth, "alice@example.com");
    const ctx = await auth.$context;
    const presence = () =>
      ctx.adapter.findMany<{ lastSeenAt: Date }>({ model: "inboxPresence" });

    await auth.api.listNotifications({ headers: alice.headers, query: {} });
    expect(await presence()).toHaveLength(0);

    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    const [first] = await presence();
    advance(30_000);
    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    expect((await presence())[0]!.lastSeenAt).toEqual(first!.lastSeenAt);
    advance(30_000);
    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    const rows = await presence();
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.lastSeenAt).getTime()).toBe(Date.now());
  });

  it("does not record presence for an impersonated session", async () => {
    const { options } = emailAfter15();
    const auth = createTestAuth(options, { plugins: [admin()] });
    const adminUser = await signUpUser(auth, "admin@example.com");
    const alice = await signUpUser(auth, "alice@example.com");
    const ctx = await auth.$context;
    await ctx.adapter.update({
      model: "user",
      where: [{ field: "id", value: adminUser.user.id }],
      update: { role: "admin" },
    });
    const { headers } = await (auth.api as any).impersonateUser({
      headers: adminUser.headers,
      body: { userId: alice.user.id },
      returnHeaders: true,
    });
    // the response clears session_token before setting the impersonation one,
    // so keep the last non-empty value per cookie name
    const jar = new Map<string, string>();
    for (const set of (headers as Headers).getSetCookie()) {
      const [pair = ""] = set.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (value) jar.set(name, pair);
    }
    const cookie = [...jar.values()].join("; ");

    const res = await auth.api.unreadCount({
      headers: new Headers({ cookie }),
      query: {},
    });
    expect(res.count).toBe(0);
    expect(
      await ctx.adapter.findMany({
        model: "inboxPresence",
        where: [{ field: "userId", value: alice.user.id }],
      }),
    ).toHaveLength(0);

    // the real user still counts
    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    expect(
      await ctx.adapter.findMany({
        model: "inboxPresence",
        where: [{ field: "userId", value: alice.user.id }],
      }),
    ).toHaveLength(1);
  });

  it("rejects a type that lists the same channel twice", () => {
    const email = fakeChannel().channel;
    expect(() =>
      inbox({
        channels: { email },
        routes: { x: [{ channel: "email" }, { channel: "email" }] },
      }),
    ).toThrow(/more than once/);
  });

  it("does not record presence when no channels are configured", async () => {
    const auth = createTestAuth();
    const alice = await signUpUser(auth, "alice@example.com");
    await auth.api.unreadCount({ headers: alice.headers, query: {} });
    const ctx = await auth.$context;
    expect(await ctx.adapter.findMany({ model: "inboxPresence" })).toHaveLength(0);
  });

  describe("touchPresence with a concurrent first write", () => {
    const T0 = new Date("2026-10-29T12:00:00.000Z");
    const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);
    const duplicateKey = () =>
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "inbox_presence_user_id_unique"',
        ),
        { code: "23505" },
      );
    const authContext = async (auth: ReturnType<typeof createTestAuth>) =>
      (await auth.$context) as unknown as AuthContext;
    const withAdapter = <C extends { adapter: object }>(
      ctx: C,
      overrides: Record<string, unknown>,
    ) => ({ ...ctx, adapter: { ...ctx.adapter, ...overrides } }) as C;

    it("updates the row when a duplicate insert means a concurrent write won", async () => {
      const auth = createTestAuth(emailAfter15().options);
      const alice = await signUpUser(auth, "alice@example.com");
      const ctx = await authContext(auth);
      await touchPresence(ctx, alice.user.id, at(0));

      // the first read misses (the other write was not visible yet), then the insert collides
      let misses = 1;
      const raced = withAdapter(ctx, {
        findOne: async (args: { model: string }) =>
          args.model === "inboxPresence" && misses-- > 0
            ? null
            : ctx.adapter.findOne(args as never),
        create: async () => {
          throw duplicateKey();
        },
      });
      await expect(touchPresence(raced, alice.user.id, at(5))).resolves.toBeUndefined();

      const rows = await ctx.adapter.findMany<{ lastSeenAt: Date }>({
        model: "inboxPresence",
        where: [{ field: "userId", value: alice.user.id }],
      });
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0]!.lastSeenAt).getTime()).toBe(at(5).getTime());
    });

    it("rethrows an insert failure when no row exists", async () => {
      const auth = createTestAuth(emailAfter15().options);
      const alice = await signUpUser(auth, "alice@example.com");
      const ctx = await authContext(auth);
      const broken = withAdapter(ctx, {
        findOne: async () => null,
        create: async () => {
          throw duplicateKey();
        },
      });
      await expect(touchPresence(broken, alice.user.id, at(0))).rejects.toThrow(
        /duplicate key/,
      );
      expect(
        await ctx.adapter.findMany({
          model: "inboxPresence",
          where: [{ field: "userId", value: alice.user.id }],
        }),
      ).toHaveLength(0);
    });

    it("never moves lastSeenAt backwards for a stale read", async () => {
      const auth = createTestAuth(emailAfter15().options);
      const alice = await signUpUser(auth, "alice@example.com");
      const ctx = await authContext(auth);
      await touchPresence(ctx, alice.user.id, at(0));
      // a read taken at T0, before a newer write lands at T5
      const stale = await ctx.adapter.findOne<{ id: string; lastSeenAt: Date }>({
        model: "inboxPresence",
        where: [{ field: "userId", value: alice.user.id }],
      });
      await touchPresence(ctx, alice.user.id, at(5));

      const behind = withAdapter(ctx, { findOne: async () => stale });
      await touchPresence(behind, alice.user.id, at(3));

      const rows = await ctx.adapter.findMany<{ lastSeenAt: Date }>({
        model: "inboxPresence",
        where: [{ field: "userId", value: alice.user.id }],
      });
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0]!.lastSeenAt).getTime()).toBe(at(5).getTime());
    });
  });
});

describe("notify inside a better-auth transaction", () => {
  // due now, so without a transaction notify would send it inside the call
  function sendNow() {
    const tasks: Promise<unknown>[] = [];
    const email = fakeChannel();
    const auth = createTestAuthWithOrg(
      {
        channels: { email: email.channel },
        routes: { "order.shipped": [{ channel: "email" }] },
      },
      { advanced: { backgroundTasks: { handler: (p) => void tasks.push(p) } } },
    );
    return { auth, email, tasks };
  }
  const inTransaction = async (
    auth: { $context: Promise<any> },
    fn: () => Promise<unknown>,
  ) => runWithTransaction((await auth.$context).adapter, fn);
  const countRows = async (auth: { $context: Promise<any> }, model: string) =>
    (await auth.$context).adapter.count({ model });
  const shipped = { type: "order.shipped", title: "Your order shipped" };

  it("commits the notification and its delivery with the caller's transaction", async () => {
    const { auth, email, tasks } = sendNow();
    const alice = await signUpUser(auth, "alice@example.com");
    tasks.length = 0;

    await inTransaction(auth, () =>
      auth.api.notify({ body: { userId: alice.user.id, ...shipped } }),
    );

    expect(await countRows(auth, "notification")).toBe(1);
    expect(await countRows(auth, "notificationDelivery")).toBe(1);
    // nothing is sent while the transaction is open: the sweep sends it after the commit
    expect(tasks).toHaveLength(0);
    expect(email.channel.deliver).not.toHaveBeenCalled();
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
  });

  it("rolls back with the caller's transaction and never sends", async () => {
    const { auth, email, tasks } = sendNow();
    const alice = await signUpUser(auth, "alice@example.com");
    tasks.length = 0;

    await expect(
      inTransaction(auth, async () => {
        await auth.api.notify({ body: { userId: alice.user.id, ...shipped } });
        throw new Error("directory write failed");
      }),
    ).rejects.toThrow("directory write failed");

    expect(await countRows(auth, "notification")).toBe(0);
    expect(await countRows(auth, "notificationDelivery")).toBe(0);
    expect(tasks).toHaveLength(0);
    expect(email.channel.deliver).not.toHaveBeenCalled();
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 0 });
  });

  it("fans an organization notify out with the caller's transaction, and rolls it back", async () => {
    const { auth, email, tasks } = sendNow();
    const alice = await signUpUser(auth, "alice@example.com");
    const bob = await signUpUser(auth, "bob@example.com");
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: "acme", slug: "acme" },
    });
    if (!org) throw new Error("org creation failed");
    await auth.api.addMember({
      body: { userId: bob.user.id, organizationId: org.id, role: "member" },
    });
    tasks.length = 0;
    const fanOut = () =>
      auth.api.notify({ body: { organizationId: org.id, ...shipped } });

    await expect(
      inTransaction(auth, async () => {
        await fanOut();
        throw new Error("directory write failed");
      }),
    ).rejects.toThrow("directory write failed");
    expect(await countRows(auth, "notification")).toBe(0);
    expect(await countRows(auth, "notificationDelivery")).toBe(0);
    expect(email.channel.deliver).not.toHaveBeenCalled();

    await inTransaction(auth, fanOut);
    expect(await countRows(auth, "notification")).toBe(2);
    expect(await countRows(auth, "notificationDelivery")).toBe(2);
    expect(tasks).toHaveLength(0);
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 2 });
  });
});
