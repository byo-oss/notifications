import { getAuthTables } from "@better-auth/core/db";
import { createAuthClient } from "better-auth/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxClient } from "../client";
import { exportNotificationsData } from "../data";
import {
  generateVapidKeys,
  inbox,
  type InboxOptions,
  type WebPushOptions,
} from "../index";
import type { NotificationDelivery, PushSubscriptionRow } from "../schema";
import { createTestAuth, signUpUser } from "../test-utils";
import {
  fakePushSubscription,
  fakePushTransport,
  type FakePushTransport,
} from "../testing";

beforeEach(() => {
  // every push in this file goes through a fake transport; the real one must never run
  vi.stubGlobal("fetch", () => {
    throw new Error("fetch must not be called in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

const SUBJECT = "mailto:ops@example.test";
let vapid: WebPushOptions["vapid"];
beforeEach(async () => {
  vapid = { subject: SUBJECT, ...(await generateVapidKeys()) };
});

type Logged = { level: string; message: string; args: unknown[] };

async function setup(
  overrides: {
    webPush?: Partial<WebPushOptions>;
    inbox?: InboxOptions;
    transport?: FakePushTransport;
  } = {},
) {
  const logs: Logged[] = [];
  const transport = overrides.transport ?? fakePushTransport();
  const auth = createTestAuth(
    {
      appUrl: "https://app.test",
      webPush: { vapid, transport, ...overrides.webPush },
      routes: { "eve.briefing_ready": [{ channel: "push" }] },
      ...overrides.inbox,
    },
    {
      logger: {
        level: "debug",
        log: (level, message, ...args) => void logs.push({ level, message, args }),
      },
    },
  );
  const alice = await signUpUser(auth, "alice@example.com");
  const context = await auth.$context;
  const rows = () =>
    context.adapter.findMany<PushSubscriptionRow>({
      model: "pushSubscription",
      limit: 1000,
    });
  const deliveries = () =>
    context.adapter.findMany<NotificationDelivery>({
      model: "notificationDelivery",
      limit: 1000,
    });
  const subscribe = async (device?: Awaited<ReturnType<typeof fakePushSubscription>>) => {
    const sub = device ?? (await fakePushSubscription());
    await auth.api.subscribeWebPush({ headers: alice.headers, body: sub.toJSON() });
    return sub;
  };
  const notify = (extra: Record<string, unknown> = {}) =>
    auth.api.notify({
      body: {
        userId: alice.user.id,
        type: "eve.briefing_ready",
        title: "Briefing ready",
        href: "/chat/abc",
        ...extra,
      },
    });
  return { auth, alice, context, rows, deliveries, subscribe, notify, transport, logs };
}

const everythingLogged = (logs: Logged[]) =>
  JSON.stringify(logs, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack}` : v));

describe("subscribe, status, unsubscribe", () => {
  it("saves a subscription with the current key and nothing else", async () => {
    const { subscribe, rows, alice } = await setup();
    const sub = await subscribe();
    const [row] = await rows();
    expect(row).toMatchObject({
      userId: alice.user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    });
    expect(row!.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
    expect(Object.keys(row!).sort()).toEqual(
      ["auth", "createdAt", "endpoint", "id", "keyId", "lastUsedAt", "p256dh", "userId"],
    );
  });

  it("drops extra body fields such as expirationTime and a spoofed userId", async () => {
    const { auth, alice, rows } = await setup();
    const sub = await fakePushSubscription();
    await auth.api.subscribeWebPush({
      headers: alice.headers,
      body: { ...sub.toJSON(), expirationTime: null, userId: "someone-else", keyId: "forged" } as never,
    });
    const [row] = await rows();
    expect(row!.userId).toBe(alice.user.id);
    expect(row!.keyId).not.toBe("forged");
  });

  it("reports the public key, whether the user is subscribed and whether an endpoint is", async () => {
    const { auth, alice, subscribe } = await setup();
    const before = await auth.api.webPushStatus({ headers: alice.headers, body: {} });
    expect(before).toEqual({
      vapidPublicKey: vapid.publicKey,
      subscribed: false,
      endpointRegistered: null,
    });
    const sub = await subscribe();
    const other = await fakePushSubscription();
    expect(
      await auth.api.webPushStatus({ headers: alice.headers, body: { endpoint: sub.endpoint } }),
    ).toMatchObject({ subscribed: true, endpointRegistered: true });
    expect(
      await auth.api.webPushStatus({ headers: alice.headers, body: { endpoint: other.endpoint } }),
    ).toMatchObject({ subscribed: true, endpointRegistered: false });
  });

  it("unsubscribes the caller's own endpoint, never another user's", async () => {
    const { auth, alice, subscribe, rows } = await setup();
    const sub = await subscribe();
    const bob = await signUpUser(auth, "bob@example.com");

    expect(
      await auth.api.unsubscribeWebPush({ headers: bob.headers, body: { endpoint: sub.endpoint } }),
    ).toEqual({ removed: 0 });
    expect(await rows()).toHaveLength(1);

    expect(
      await auth.api.unsubscribeWebPush({ headers: alice.headers, body: { endpoint: sub.endpoint } }),
    ).toEqual({ removed: 1 });
    expect(await rows()).toHaveLength(0);
  });

  it("subscribing the same endpoint twice keeps one row and refreshes its keys", async () => {
    const { subscribe, rows, auth, alice } = await setup();
    const sub = await subscribe();
    const renewed = await fakePushSubscription({ endpoint: sub.endpoint });
    await auth.api.subscribeWebPush({ headers: alice.headers, body: renewed.toJSON() });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.p256dh).toBe(renewed.keys.p256dh);
  });

  it("moves an endpoint to the next person who signs in on that browser", async () => {
    const { auth, subscribe, rows } = await setup();
    const sub = await subscribe();
    const bob = await signUpUser(auth, "bob@example.com");
    await auth.api.subscribeWebPush({ headers: bob.headers, body: sub.toJSON() });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.userId).toBe(bob.user.id);
  });

  it("keeps at most 20 devices per user, dropping the longest unused", async () => {
    const { subscribe, rows } = await setup();
    const first = await subscribe();
    for (let i = 0; i < 24; i++) await subscribe();
    const all = await rows();
    expect(all).toHaveLength(20);
    expect(all.some((row) => row.endpoint === first.endpoint)).toBe(false);
  });

  it("needs a session on every endpoint", async () => {
    const { auth } = await setup();
    const sub = await fakePushSubscription();
    const attempts = [
      auth.api.subscribeWebPush({ body: sub.toJSON() }),
      auth.api.unsubscribeWebPush({ body: { endpoint: sub.endpoint } }),
      auth.api.webPushStatus({ body: {} }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    }
    for (const path of ["subscribe", "unsubscribe", "status"]) {
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth/inbox/push/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        }),
      );
      expect(response.status).toBe(401);
    }
  });
});

describe("subscribe refuses what could be abused", () => {
  const cases: [string, string][] = [
    ["plain http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["loopback", "https://127.0.0.1/hook"],
    ["localhost", "https://localhost:3000/hook"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["a private address", "https://10.0.0.8/x"],
    ["credentials in the URL", "https://u:p@fcm.googleapis.com/x"],
    ["a look-alike host", "https://fcm.googleapis.com.evil.test/x"],
    ["a host that is not a push service", "https://example.com/x"],
    ["a non-default port", "https://fcm.googleapis.com:8443/x"],
    ["not a URL", "javascript:alert(1)"],
  ];
  it.each(cases)("refuses %s with a 400 that doesn't echo the endpoint", async (_name, endpoint) => {
    const { auth, alice, rows, logs } = await setup();
    const sub = await fakePushSubscription();
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/inbox/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: alice.headers.get("cookie")!, origin: "http://localhost:3000" },
        body: JSON.stringify({ endpoint, keys: sub.keys }),
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("PUSH_ENDPOINT_NOT_ALLOWED");
    expect(text).not.toContain(endpoint);
    expect(await rows()).toHaveLength(0);
    expect(everythingLogged(logs)).not.toContain(endpoint);
  });

  it("accepts a host once allowedHosts lists it, and no longer the defaults", async () => {
    const { auth, alice, rows } = await setup({ webPush: { allowedHosts: ["push.example.test"] } });
    const own = await fakePushSubscription({ endpoint: "https://push.example.test/abc" });
    await auth.api.subscribeWebPush({ headers: alice.headers, body: own.toJSON() });
    expect(await rows()).toHaveLength(1);
    const fcm = await fakePushSubscription();
    await expect(
      auth.api.subscribeWebPush({ headers: alice.headers, body: fcm.toJSON() }),
    ).rejects.toMatchObject({ body: { code: "PUSH_ENDPOINT_NOT_ALLOWED" } });
  });

  it("refuses keys that are not a P-256 point and a 16-byte secret", async () => {
    const { auth, alice, rows } = await setup();
    const sub = await fakePushSubscription();
    const other = await fakePushSubscription();
    const bad = [
      { p256dh: "AAAA", auth: sub.keys.auth },
      { p256dh: sub.keys.p256dh, auth: "AAAA" },
      { p256dh: `B${"A".repeat(86)}`, auth: sub.keys.auth }, // 65 bytes, off the curve
      { p256dh: "!!not base64!!", auth: sub.keys.auth },
      { p256dh: other.keys.auth, auth: sub.keys.auth },
    ];
    for (const keys of bad) {
      await expect(
        auth.api.subscribeWebPush({ headers: alice.headers, body: { endpoint: sub.endpoint, keys } }),
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
    }
    expect(await rows()).toHaveLength(0);
  });
});

describe("push through notify and the sweep", () => {
  it("sends an encrypted push to the user's devices and marks the delivery sent", async () => {
    const { subscribe, notify, auth, transport, deliveries } = await setup();
    const phone = await subscribe();
    const laptop = await subscribe();
    await notify();
    await auth.api.processDeliveries({});

    expect(transport.sent).toHaveLength(2);
    const byEndpoint = new Map(transport.sent.map((s) => [s.endpoint, s]));
    for (const device of [phone, laptop]) {
      const sent = byEndpoint.get(device.endpoint)!;
      expect(await device.decrypt(sent)).toEqual({
        title: "Briefing ready",
        href: "/chat/abc",
        id: expect.any(String),
      });
      expect(sent.ttl).toBe(86_400);
      expect(sent.urgency).toBe("normal");
    }
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ channel: "push", status: "sent" });
  });

  it("does not repeat a push that already went out, when another notification is swept", async () => {
    const { subscribe, notify, auth, transport } = await setup();
    await subscribe();
    await notify();
    await auth.api.processDeliveries({});
    await auth.api.processDeliveries({});
    expect(transport.sent).toHaveLength(1);
  });

  it("settles on one device accepting: the other device failing doesn't trigger a repeat", async () => {
    const good = await fakePushSubscription();
    const flaky = await fakePushSubscription();
    const transport = fakePushTransport({
      respond: (request) => (request.url === flaky.endpoint ? 503 : 201),
    });
    const { subscribe, notify, auth, deliveries } = await setup({ transport });
    await subscribe(good);
    await subscribe(flaky);
    await notify();
    await auth.api.processDeliveries({});
    const [delivery] = await deliveries();
    expect(delivery!.status).toBe("sent");
    transport.clear();
    await auth.api.processDeliveries({});
    expect(transport.sent).toHaveLength(0);
  });

  it("retries when the push service is down and keeps the subscription", async () => {
    const transport = fakePushTransport({ respond: 503 });
    const { subscribe, notify, auth, deliveries, rows, logs } = await setup({ transport });
    const sub = await subscribe();
    await notify();
    const result = await auth.api.processDeliveries({});
    expect(result).toMatchObject({ sent: 0, retrying: 1, failed: 0 });
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ status: "pending", attempts: 1 });
    expect(delivery!.detail).toBe(
      "web push failed for 1 of 1 subscriptions (503), will retry",
    );
    expect(await rows()).toHaveLength(1);
    // the sweep logs the failure; the endpoint is not in it
    expect(logs.some((l) => l.level === "error" && l.message.includes("push delivery"))).toBe(true);
    expect(everythingLogged(logs)).not.toContain(new URL(sub.endpoint).pathname);
    expect(everythingLogged(logs)).not.toContain(sub.keys.auth);
  });

  it("deletes the row on 410 and still marks the delivery sent", async () => {
    const transport = fakePushTransport({ respond: 410 });
    const { subscribe, notify, auth, deliveries, rows } = await setup({ transport });
    await subscribe();
    await notify();
    expect(await auth.api.processDeliveries({})).toMatchObject({ sent: 1, failed: 0 });
    expect(await rows()).toHaveLength(0);
    expect((await deliveries())[0]!.status).toBe("sent");
  });

  it("on 403 deletes the row, fails the delivery and keeps the endpoint out of detail and events", async () => {
    const events: unknown[] = [];
    const transport = fakePushTransport({ respond: 403 });
    const { subscribe, notify, auth, deliveries, rows, logs } = await setup({
      transport,
      inbox: { onEvent: (event) => void events.push(event) },
    });
    const sub = await subscribe();
    await notify();
    expect(await auth.api.processDeliveries({})).toMatchObject({ failed: 1 });
    expect(await rows()).toHaveLength(0);
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ status: "failed" });
    expect(delivery!.detail).toBe("web push refused by 1 of 1 subscriptions (403)");
    const seen = JSON.stringify([delivery, events, everythingLogged(logs)]);
    expect(seen).not.toContain(new URL(sub.endpoint).pathname);
    expect(seen).not.toContain(sub.keys.p256dh);
    expect(seen).toContain("permanent");
  });

  it("keeps endpoints, keys and message text out of every log line, whatever fails", async () => {
    const sub = await fakePushSubscription();
    const secrets = (title: string, body: string) => [
      new URL(sub.endpoint).pathname,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      title,
      body,
      vapid.privateKey,
    ];
    const title = "Confidential title";
    const body = "Confidential body";
    for (const respond of [
      503,
      403,
      429,
      400,
      () => {
        throw new Error(`socket hang up ${sub.endpoint}`, { cause: new Error(sub.endpoint) });
      },
    ] as const) {
      const transport = fakePushTransport({ respond });
      const { subscribe, notify, auth, deliveries, logs } = await setup({
        transport,
        inbox: { maxAttempts: 1 },
      });
      await subscribe(sub);
      await notify({ title, body });
      await auth.api.processDeliveries({});
      const seen = JSON.stringify([everythingLogged(logs), await deliveries()]);
      expect(seen).toContain("web push"); // the failure was logged, so the check below means something
      for (const secret of secrets(title, body)) expect(seen).not.toContain(secret);
    }
  });

  it("prunes rows saved under another VAPID key during the sweep", async () => {
    const { subscribe, context, rows, auth } = await setup();
    await subscribe();
    const old = await fakePushSubscription();
    await context.adapter.create({
      model: "pushSubscription",
      data: {
        userId: (await rows())[0]!.userId,
        endpoint: old.endpoint,
        p256dh: old.keys.p256dh,
        auth: old.keys.auth,
        keyId: "an-older-key-id",
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    });
    expect(await rows()).toHaveLength(2);
    await auth.api.processDeliveries({});
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0]!.endpoint).not.toBe(old.endpoint);
  });

  it("respects shouldDeliver, so an app can keep per-user opt-outs", async () => {
    const { subscribe, notify, auth, transport } = await setup({
      inbox: { shouldDeliver: () => false },
    });
    await subscribe();
    await notify();
    await auth.api.processDeliveries({});
    expect(transport.sent).toHaveLength(0);
  });

  it("pushes only for types routed to push", async () => {
    const { subscribe, notify, auth, transport } = await setup();
    await subscribe();
    await notify({ type: "other.type" });
    await auth.api.processDeliveries({});
    expect(transport.sent).toHaveLength(0);
  });
});

describe("user data", () => {
  it("removes a deleted user's subscriptions on an adapter without foreign keys", async () => {
    const { subscribe, context, rows, alice } = await setup();
    await subscribe();
    await context.internalAdapter.deleteUser(alice.user.id);
    expect(await rows()).toHaveLength(0);
  });

  it("leaves subscription credentials out of exportNotificationsData", async () => {
    const { subscribe, notify, auth } = await setup();
    const sub = await subscribe();
    await notify();
    await auth.api.processDeliveries({});
    const exported = JSON.stringify(await exportNotificationsData(auth));
    expect(exported).toContain("Briefing ready");
    for (const secret of [sub.endpoint, sub.keys.p256dh, sub.keys.auth, "p256dh", "endpoint", "pushSubscription"]) {
      expect(exported).not.toContain(secret);
    }
  });
});

describe("the client", () => {
  const clientFor = (auth: Awaited<ReturnType<typeof setup>>["auth"], headers: Headers) =>
    createAuthClient({
      baseURL: "http://localhost:3000",
      plugins: [inboxClient()],
      fetchOptions: {
        customFetchImpl: (input, init) => auth.handler(new Request(input, init)),
        headers,
      },
    });

  it("subscribes with a PushSubscription's JSON, reports status and unsubscribes", async () => {
    const { auth, alice, rows } = await setup();
    const client = clientFor(auth, alice.headers);
    const sub = await fakePushSubscription();

    const status = await client.webPushStatus();
    expect(status.data).toEqual({
      vapidPublicKey: vapid.publicKey,
      subscribed: false,
      endpointRegistered: null,
    });

    // a real PushSubscription has endpoint and toJSON(); either shape works
    const saved = await client.subscribeWebPush({ endpoint: sub.endpoint, toJSON: sub.toJSON } as never);
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual({ subscribed: true });
    expect(await rows()).toHaveLength(1);

    expect((await client.webPushStatus(sub.toJSON())).data).toMatchObject({
      subscribed: true,
      endpointRegistered: true,
    });

    expect((await client.unsubscribeWebPush(sub.toJSON())).data).toEqual({ removed: 1 });
    expect(await rows()).toHaveLength(0);
  });

  it("exposes the same routes through the typed path proxy", async () => {
    const { auth, alice } = await setup();
    const client = clientFor(auth, alice.headers);
    const sub = await fakePushSubscription();
    const saved = await client.inbox.push.subscribe(sub.toJSON());
    expect(saved.error).toBeNull();
    expect((await client.inbox.push.status({})).data?.subscribed).toBe(true);
  });

  it("returns the server's refusal for a bad endpoint", async () => {
    const { auth, alice } = await setup();
    const client = clientFor(auth, alice.headers);
    const sub = await fakePushSubscription({ endpoint: "https://127.0.0.1/x" });
    const result = await client.subscribeWebPush(sub.toJSON());
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toBe("This push endpoint is not allowed");
  });
});

describe("configuration", () => {
  const make = (webPush: Partial<WebPushOptions> | undefined, extra: InboxOptions = {}) =>
    inbox({ webPush: webPush as WebPushOptions, ...extra });

  it("fails at boot for a bad VAPID key, subject, ttl, urgency or host list, without printing a key", async () => {
    const good = { subject: SUBJECT, ...(await generateVapidKeys()) };
    const throwing = [
      { vapid: { ...good, publicKey: "nope" } },
      { vapid: { ...good, privateKey: good.publicKey } },
      { vapid: { ...good, subject: "admin" } },
      { vapid: good, ttl: -1 },
      { vapid: good, ttl: 1.5 },
      { vapid: good, urgency: "urgent" as never },
      { vapid: good, allowedHosts: [] },
      { vapid: good, allowedHosts: ["*"] },
    ];
    for (const webPush of throwing) {
      let message = "";
      try {
        make(webPush);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(webPush))).toMatch(/^\[@byo-oss\/notifications\] /);
      expect(message).not.toContain(good.privateKey);
      expect(message).not.toContain(good.publicKey);
    }
  });

  it('reserves the channel name "push" when webPush is set, and says what a route needs', () => {
    expect(() =>
      make({ vapid }, { channels: { push: { deliver: async () => {} } } }),
    ).toThrow(/channels\.push is reserved/);
    expect(() =>
      inbox({ routes: { "a.b": [{ channel: "push" }] } }),
    ).toThrow(/needs the webPush option/);
    // without webPush a custom channel named push still works, as before
    expect(() =>
      inbox({
        channels: { push: { deliver: async () => {} } },
        routes: { "a.b": [{ channel: "push" }] },
      }),
    ).not.toThrow();
  });

  it("adds the table, with every reference cascading, only with webPush", () => {
    const withPush = getAuthTables({ plugins: [inbox({ webPush: { vapid } })] });
    expect(Object.keys(withPush.pushSubscription!.fields).sort()).toEqual(
      ["auth", "createdAt", "endpoint", "keyId", "lastUsedAt", "p256dh", "userId"],
    );
    expect(withPush.pushSubscription!.fields.userId!.references).toEqual({
      model: "user",
      field: "id",
      onDelete: "cascade",
    });
    expect(withPush.pushSubscription!.fields.endpoint!.unique).toBe(true);
    expect(getAuthTables({ plugins: [inbox()] }).pushSubscription).toBeUndefined();
  });

  it("renames the table with the schema option, and ignores that rename without webPush", () => {
    const schema = { pushSubscription: { modelName: "web_push_device" } };
    const renamed = getAuthTables({ plugins: [inbox({ webPush: { vapid }, schema })] });
    expect(renamed.pushSubscription!.modelName).toBe("web_push_device");
    const without = getAuthTables({ plugins: [inbox({ schema })] });
    expect(without.pushSubscription).toBeUndefined();
    expect(JSON.stringify(without)).not.toContain("web_push_device");
  });

  it("accepts a key pair from generateVapidKeys", async () => {
    const keys = await generateVapidKeys();
    expect(() => inbox({ webPush: { vapid: { subject: SUBJECT, ...keys } } })).not.toThrow();
  });
});
