import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PermanentDeliveryError } from "../permanent";
import type { PushSubscriptionRow } from "../schema";
import {
  deliveryContext,
  fakePushSubscription,
  fakePushTransport,
  type FakePushTransport,
  testChannel,
} from "../testing";
import { createPushChannel, topicFor } from "./channel";
import { createVapidSigner, generateVapidKeys, type VapidSigner } from "./crypto";
import { DEFAULT_PUSH_HOSTS } from "./hosts";
import type { PushStore } from "./store";
import type { PushTransport } from "./transport";

// A test that falls back to the default transport must fail loudly, not send.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("fetch must not be called in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

type Device = Awaited<ReturnType<typeof fakePushSubscription>>;

let signer: VapidSigner;
let otherSigner: VapidSigner;
beforeAll(async () => {
  const subject = "mailto:ops@example.test";
  signer = await createVapidSigner({ subject, ...(await generateVapidKeys()) });
  otherSigner = await createVapidSigner({ subject, ...(await generateVapidKeys()) });
});

function memoryStore(rows: PushSubscriptionRow[]) {
  const store: PushStore & { rows: PushSubscriptionRow[] } = {
    rows,
    async list(userId) {
      return store.rows.filter((row) => row.userId === userId);
    },
    async remove(ids) {
      store.rows = store.rows.filter((row) => !ids.includes(row.id));
    },
    async touch(id, at) {
      const row = store.rows.find((r) => r.id === id);
      if (row) row.lastUsedAt = at;
    },
  };
  return store;
}

const rowFor = (
  device: Device,
  overrides: Partial<PushSubscriptionRow> = {},
): PushSubscriptionRow => ({
  id: `row-${device.endpoint.slice(-8)}`,
  userId: "user-1",
  endpoint: device.endpoint,
  p256dh: device.keys.p256dh,
  auth: device.keys.auth,
  keyId: signer.keyId,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

async function setup(
  options: {
    devices?: number;
    transport?: PushTransport;
    rows?: (devices: Device[]) => PushSubscriptionRow[];
    ttl?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    allowedHosts?: readonly string[];
  } = {},
) {
  const devices = await Promise.all(
    Array.from({ length: options.devices ?? 1 }, () => fakePushSubscription()),
  );
  const store = memoryStore(
    options.rows ? options.rows(devices) : devices.map((d) => rowFor(d)),
  );
  const fake = fakePushTransport();
  const channel = createPushChannel(store, {
    vapid: async () => signer,
    transport: options.transport ?? fake,
    ttl: options.ttl ?? 86_400,
    urgency: options.urgency ?? "normal",
    allowedHosts: options.allowedHosts ?? DEFAULT_PUSH_HOSTS,
  });
  return { channel, store, devices, fake };
}

const respondWith = (...statuses: number[]) => {
  let i = 0;
  return fakePushTransport({ respond: () => statuses[i++ % statuses.length]! });
};

// byStatus lets one fake answer per endpoint, whatever order the requests run in
const byEndpoint = (answers: Map<string, number>) =>
  fakePushTransport({ respond: (request) => answers.get(request.url) ?? 201 });

describe("push channel: the InboxChannel contract", () => {
  const contractStore = async () => {
    const device = await fakePushSubscription();
    return memoryStore([rowFor(device)]);
  };
  const build = async (transport: PushTransport) =>
    createPushChannel(await contractStore(), {
      vapid: async () => signer,
      transport,
      ttl: 86_400,
      urgency: "normal",
      allowedHosts: DEFAULT_PUSH_HOSTS,
    });

  testChannel(() => build(fakePushTransport()), {
    failing: () => build(fakePushTransport({ respond: 503 })),
    permanentlyFailing: () => build(fakePushTransport({ respond: 403 })),
  });

  testChannel(() => build(fakePushTransport()), {
    failing: () =>
      build(async () => {
        throw new TypeError("fetch failed");
      }),
  });
});

describe("push channel: what is sent", () => {
  it("sends one encrypted, VAPID-signed request with TTL, Urgency and Topic", async () => {
    const { channel, fake, devices } = await setup();
    const ctx = deliveryContext({
      notification: { id: "n-42", title: "Briefing ready", body: null, href: "/chat/9" },
      appUrl: "https://app.test",
    });
    await channel.deliver(ctx);

    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0]!;
    expect(sent.endpoint).toBe(devices[0]!.endpoint);
    expect(sent.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(sent.headers["Content-Type"]).toBe("application/octet-stream");
    expect(sent.ttl).toBe(86_400);
    expect(sent.urgency).toBe("normal");
    expect(sent.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(sent.topic).toBe(await topicFor("n-42"));
    expect(sent.topic).not.toContain("n-42");
    expect(sent.authorization).toMatch(
      /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/,
    );
    const claims = JSON.parse(
      atob(sent.authorization.split("t=")[1]!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(await devices[0]!.decrypt(sent)).toEqual({
      title: "Briefing ready",
      href: "/chat/9",
      id: "n-42",
    });
  });

  it("honours ttl and urgency", async () => {
    const { channel, fake } = await setup({ ttl: 0, urgency: "high" });
    await channel.deliver(deliveryContext());
    expect(fake.sent[0]!.ttl).toBe(0);
    expect(fake.sent[0]!.urgency).toBe("high");
  });

  it("uses one Topic per notification, so a retry collapses, and a different one for another", async () => {
    const { channel, fake } = await setup();
    await channel.deliver(deliveryContext({ notification: { id: "a" } }));
    await channel.deliver(deliveryContext({ notification: { id: "a" } }));
    await channel.deliver(deliveryContext({ notification: { id: "b" } }));
    expect(fake.sent[0]!.topic).toBe(fake.sent[1]!.topic);
    expect(fake.sent[0]!.topic).not.toBe(fake.sent[2]!.topic);
  });

  it("encrypts a body of any length within the 4096-byte limit", async () => {
    const { channel, fake } = await setup();
    await channel.deliver(
      deliveryContext({ notification: { title: "t".repeat(9000), body: "\u{1F600}".repeat(9000) } }),
    );
    expect(fake.sent[0]!.body.length).toBeLessThanOrEqual(4096);
  });

  it("sends only title, body, href and id", async () => {
    const { channel, fake, devices } = await setup();
    await channel.deliver(
      deliveryContext({
        notification: { data: { token: "secret-token" }, type: "x.y", organizationId: "org-9" },
      }),
    );
    const payload = await devices[0]!.decrypt(fake.sent[0]!);
    expect(Object.keys(payload).sort()).toEqual(["body", "href", "id", "title"]);
  });

  it("does nothing, and resolves, for a user with no subscriptions", async () => {
    const { channel, fake } = await setup({ devices: 0 });
    await expect(channel.deliver(deliveryContext())).resolves.toBeUndefined();
    expect(fake.sent).toHaveLength(0);
  });

  it("pushes only to the notification's recipient", async () => {
    const { channel, fake, devices } = await setup({
      devices: 2,
      rows: (d) => [rowFor(d[0]!), rowFor(d[1]!, { userId: "someone-else" })],
    });
    await channel.deliver(deliveryContext());
    expect(fake.sent.map((s) => s.endpoint)).toEqual([devices[0]!.endpoint]);
  });
});

describe("push channel: what the push service answers", () => {
  it.each([404, 410])("%i deletes the subscription and resolves", async (status) => {
    const { channel, store } = await setup({ transport: respondWith(status) });
    await expect(channel.deliver(deliveryContext())).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(0);
  });

  it("403 deletes the subscription and fails for good", async () => {
    const { channel, store } = await setup({ transport: respondWith(403) });
    const error = await channel.deliver(deliveryContext()).catch((e) => e);
    expect(error).toBeInstanceOf(PermanentDeliveryError);
    expect(store.rows).toHaveLength(0);
  });

  it.each([429, 500, 502, 503, 504, 408])(
    "%i keeps the subscription and retries",
    async (status) => {
      const { channel, store } = await setup({ transport: respondWith(status) });
      const error = await channel.deliver(deliveryContext()).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PermanentDeliveryError);
      expect(error.permanent).toBeUndefined();
      expect(store.rows).toHaveLength(1);
    },
  );

  it.each([400, 401, 413, 301, 302, 307])(
    "%i keeps the subscription and fails without retrying",
    async (status) => {
      const { channel, store } = await setup({ transport: respondWith(status) });
      const error = await channel.deliver(deliveryContext()).catch((e) => e);
      expect(error).toBeInstanceOf(PermanentDeliveryError);
      expect(store.rows).toHaveLength(1);
    },
  );

  it("a network failure keeps the subscription and retries", async () => {
    const { channel, store } = await setup({
      transport: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });
    const error = await channel.deliver(deliveryContext()).catch((e) => e);
    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
    expect(store.rows).toHaveLength(1);
  });

  it("records lastUsedAt on a send the push service accepted", async () => {
    const { channel, store } = await setup();
    await channel.deliver(deliveryContext());
    expect(store.rows[0]!.lastUsedAt.getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
  });
});

describe("push channel: several devices", () => {
  it("resolves when any device accepts, and tidies the rest", async () => {
    const { store, devices } = await setup({ devices: 3 });
    const answers = new Map([
      [devices[0]!.endpoint, 201],
      [devices[1]!.endpoint, 503],
      [devices[2]!.endpoint, 410],
    ]);
    const channelWith = createPushChannel(store, {
      vapid: async () => signer,
      transport: byEndpoint(answers),
      ttl: 60,
      urgency: "normal",
      allowedHosts: DEFAULT_PUSH_HOSTS,
    });
    await expect(channelWith.deliver(deliveryContext())).resolves.toBeUndefined();
    // the 410 is gone; the 503 stays for the next notification
    expect(store.rows.map((r) => r.endpoint).sort()).toEqual(
      [devices[0]!.endpoint, devices[1]!.endpoint].sort(),
    );
  });

  it("resolves when one accepts and the others fail for good", async () => {
    const { store, devices } = await setup({ devices: 2 });
    const channel = createPushChannel(store, {
      vapid: async () => signer,
      transport: byEndpoint(new Map([[devices[1]!.endpoint, 403]])),
      ttl: 60,
      urgency: "normal",
      allowedHosts: DEFAULT_PUSH_HOSTS,
    });
    await expect(channel.deliver(deliveryContext())).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(1);
  });

  it("throws to retry when none accepted and at least one can be retried", async () => {
    const { store, devices } = await setup({ devices: 3 });
    const channel = createPushChannel(store, {
      vapid: async () => signer,
      transport: byEndpoint(
        new Map([
          [devices[0]!.endpoint, 503],
          [devices[1]!.endpoint, 403],
          [devices[2]!.endpoint, 410],
        ]),
      ),
      ttl: 60,
      urgency: "normal",
      allowedHosts: DEFAULT_PUSH_HOSTS,
    });
    const error = await channel.deliver(deliveryContext()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
    expect(store.rows).toHaveLength(1); // only the 503 is kept
  });

  it("throws PermanentDeliveryError when every device fails for good", async () => {
    const { store, devices } = await setup({ devices: 2 });
    const channel = createPushChannel(store, {
      vapid: async () => signer,
      transport: byEndpoint(
        new Map([
          [devices[0]!.endpoint, 403],
          [devices[1]!.endpoint, 400],
        ]),
      ),
      ttl: 60,
      urgency: "normal",
      allowedHosts: DEFAULT_PUSH_HOSTS,
    });
    await expect(channel.deliver(deliveryContext())).rejects.toBeInstanceOf(
      PermanentDeliveryError,
    );
  });

  it("resolves when every device is gone", async () => {
    const { channel, store } = await setup({ devices: 2, transport: respondWith(410) });
    await expect(channel.deliver(deliveryContext())).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(0);
  });
});

describe("push channel: stale and refused rows", () => {
  it("prunes rows saved under another VAPID key and never sends to them", async () => {
    const { channel, store, fake, devices } = await setup({
      devices: 2,
      rows: (d) => [rowFor(d[0]!), rowFor(d[1]!, { keyId: otherSigner.keyId })],
    });
    await channel.deliver(deliveryContext());
    expect(fake.sent.map((s) => s.endpoint)).toEqual([devices[0]!.endpoint]);
    expect(store.rows.map((r) => r.endpoint)).toEqual([devices[0]!.endpoint]);
  });

  it("resolves, with nothing sent, when only old-key rows remain", async () => {
    const { channel, store, fake } = await setup({
      rows: (d) => [rowFor(d[0]!, { keyId: otherSigner.keyId })],
    });
    await expect(channel.deliver(deliveryContext())).resolves.toBeUndefined();
    expect(fake.sent).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("refuses an endpoint that is off allowedHosts at send time, deletes the row and fails", async () => {
    const evil = await fakePushSubscription({ endpoint: "https://169.254.169.254/latest" });
    const { channel, store, fake } = await setup({
      rows: () => [rowFor(evil)],
    });
    const error = await channel.deliver(deliveryContext()).catch((e) => e);
    expect(error).toBeInstanceOf(PermanentDeliveryError);
    expect(fake.sent).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("applies a narrowed allowedHosts to rows saved before it was", async () => {
    const { channel, fake, store } = await setup({ allowedHosts: ["push.example.test"] });
    await expect(channel.deliver(deliveryContext())).rejects.toBeInstanceOf(
      PermanentDeliveryError,
    );
    expect(fake.sent).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("drops a row whose keys can't encrypt, without retrying", async () => {
    const device = await fakePushSubscription();
    const { channel, store } = await setup({
      rows: () => [rowFor(device, { p256dh: "AAAA", auth: device.keys.auth })],
    });
    await expect(channel.deliver(deliveryContext())).rejects.toBeInstanceOf(
      PermanentDeliveryError,
    );
    expect(store.rows).toHaveLength(0);
  });
});

describe("push channel: secrets stay out of errors", () => {
  const leaky = (endpoint: string): PushTransport => async () => {
    // undici and others put the URL in the message and in the cause
    throw new Error(`fetch failed for ${endpoint}`, {
      cause: new Error(`connect ETIMEDOUT ${endpoint}`),
    });
  };

  it("carries no endpoint, key, title or body in any error it throws", async () => {
    const device = await fakePushSubscription();
    const title = "Quarterly layoffs list";
    const body = "Alice, Bob and Carol";
    const cases: PushTransport[] = [
      leaky(device.endpoint),
      respondWith(503),
      respondWith(403),
      respondWith(400),
      respondWith(429),
    ];
    for (const transport of cases) {
      const { channel } = await setup({
        transport,
        rows: () => [rowFor(device)],
      });
      const error = await channel
        .deliver(deliveryContext({ notification: { title, body } }))
        .catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      const everything = `${error.name} ${error.message} ${error.stack?.split("\n")[0]} ${JSON.stringify(error.cause ?? null)}`;
      expect(error.cause).toBeUndefined();
      for (const secret of [
        device.endpoint,
        new URL(device.endpoint).pathname,
        device.keys.p256dh,
        device.keys.auth,
        title,
        body,
      ]) {
        expect(everything).not.toContain(secret);
      }
    }
  });

  it("says only how many subscriptions failed and with which statuses", async () => {
    const { channel } = await setup({ devices: 2, transport: respondWith(503, 429) });
    const error = await channel.deliver(deliveryContext()).catch((e) => e);
    expect(error.message).toBe(
      "web push failed for 2 of 2 subscriptions (503, 429), will retry",
    );
  });
});
