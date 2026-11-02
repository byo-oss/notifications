import { describe, expect, it } from "vitest";
import type { DeliveryContext, InboxChannel } from "./delivery";
import { createReceiver, decryptPushMessage } from "./push/decrypt";
import { toBase64Url } from "./push/encoding";
import type { PushPayload } from "./push/payload";
import type { PushRequest, PushTransport } from "./push/transport";

type ChannelFactory = () => InboxChannel | Promise<InboxChannel>;

export type TestChannelOptions = {
  /**
   * The same channel wired to a transport that fails (a fake client that
   * rejects, a fetch that returns 500). Checks that `deliver` throws, which is
   * what makes the delivery retry.
   */
  failing: ChannelFactory;
  /**
   * The channel wired to a transport that fails for good (an invalid address,
   * a hard bounce), if it reports those. Checks that it throws a
   * `PermanentDeliveryError` or an error with `permanent: true`.
   */
  permanentlyFailing?: ChannelFactory;
};

/** A delivery context with every optional field set. Pass overrides to vary it. */
export function deliveryContext(
  overrides: {
    notification?: Partial<DeliveryContext["notification"]>;
    user?: Partial<DeliveryContext["user"]>;
    appUrl?: string | undefined;
  } = {},
): DeliveryContext {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  return {
    notification: {
      id: "notification-1",
      userId: "user-1",
      organizationId: "org-1",
      type: "billing.payment_failed",
      title: "Payment failed",
      body: "Update your card to keep your plan.",
      href: "/settings/billing",
      data: { invoiceId: "in_1" },
      read: false,
      seenAt: null,
      createdAt,
      ...overrides.notification,
    },
    user: {
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      emailVerified: true,
      image: null,
      createdAt,
      updatedAt: createdAt,
      ...overrides.user,
    },
    appUrl: "appUrl" in overrides ? overrides.appUrl : "https://app.acme.test",
  };
}

/**
 * The `InboxChannel` contract as a vitest suite. Call it at the top level of a
 * test file with a factory that builds your channel on a fake transport:
 *
 * ```ts
 * import { testChannel } from "@byo-oss/notifications/testing"
 * testChannel(() => myChannel({ client: fakeClient }), {
 *   failing: () => myChannel({ client: rejectingClient }),
 * })
 * ```
 *
 * It checks what the inbox relies on: `deliver` resolves for any valid
 * context (with or without `body`, `href` and `appUrl`, relative or absolute
 * `href`), doesn't change its input, and throws when the send fails. Channels
 * aren't required to be idempotent: a delivery can be retried after a send
 * that succeeded but whose worker died, so the inbox promises at-least-once.
 */
export function testChannel(
  create: ChannelFactory,
  options: TestChannelOptions,
) {
  describe("InboxChannel contract", () => {
    it("has a deliver function", async () => {
      const channel = await create();
      expect(typeof channel.deliver).toBe("function");
    });

    it("delivers a notification with every field set", async () => {
      const channel = await create();
      await expect(channel.deliver(deliveryContext())).resolves.not.toThrow();
    });

    it("delivers a notification with only the required fields", async () => {
      const channel = await create();
      await expect(
        channel.deliver(
          deliveryContext({
            notification: {
              organizationId: null,
              body: null,
              href: null,
              data: null,
            },
            appUrl: undefined,
          }),
        ),
      ).resolves.not.toThrow();
    });

    it("delivers relative and absolute links, with or without appUrl", async () => {
      const channel = await create();
      for (const href of ["/inbox", "inbox", "https://elsewhere.test/x"]) {
        for (const appUrl of ["https://app.acme.test", undefined]) {
          await expect(
            channel.deliver(deliveryContext({ notification: { href }, appUrl })),
          ).resolves.not.toThrow();
        }
      }
    });

    it("doesn't change the context it's given", async () => {
      const channel = await create();
      const ctx = deliveryContext();
      const before = structuredClone(ctx);
      await channel.deliver(ctx);
      expect(ctx).toEqual(before);
    });

    it("throws when the send fails, so the delivery retries", async () => {
      const channel = await options.failing();
      await expect(channel.deliver(deliveryContext())).rejects.toThrow();
    });

    it.skipIf(!options.permanentlyFailing)(
      "marks a send that can never succeed as permanent",
      async () => {
        const channel = await options.permanentlyFailing!();
        await expect(channel.deliver(deliveryContext())).rejects.toMatchObject(
          { permanent: true },
        );
      },
    );
  });
}

/** One request `fakePushTransport` received. */
export type RecordedPush = {
  /** The subscription endpoint it was sent to. */
  endpoint: string;
  /** Header names as the library sent them (`TTL`, `Urgency`, `Topic`, ...). */
  headers: Record<string, string>;
  /** The encrypted body. */
  body: Uint8Array;
  ttl: number;
  urgency: string;
  topic: string | undefined;
  /** The `Authorization: vapid t=..., k=...` header. */
  authorization: string;
};

export type FakePushTransport = PushTransport & {
  /** Every request, in order. */
  sent: RecordedPush[];
  /** Forgets the recorded requests. */
  clear(): void;
};

export type FakePushTransportOptions = {
  /**
   * What the fake push service answers. A status code, or a function of the
   * request that returns one (or throws, to simulate a network failure).
   * @default 201
   */
  respond?: number | ((request: PushRequest) => number | Promise<number>);
};

/**
 * A `webPush.transport` that records every send and never touches the
 * network. Pass it to `inbox({ webPush: { transport } })` in tests and read
 * `transport.sent`.
 *
 * ```ts
 * const transport = fakePushTransport()
 * const auth = betterAuth({ plugins: [inbox({ webPush: { vapid, transport } })] })
 * // ...notify, then
 * expect(transport.sent).toHaveLength(1)
 * ```
 */
export function fakePushTransport(
  options: FakePushTransportOptions = {},
): FakePushTransport {
  const sent: RecordedPush[] = [];
  const transport: PushTransport = async (request) => {
    sent.push({
      endpoint: request.url,
      headers: { ...request.headers },
      body: request.body,
      ttl: Number(request.headers.TTL),
      urgency: request.headers.Urgency ?? "",
      topic: request.headers.Topic,
      authorization: request.headers.Authorization ?? "",
    });
    const respond = options.respond ?? 201;
    const status = typeof respond === "number" ? respond : await respond(request);
    return { status };
  };
  return Object.assign(transport, {
    sent,
    clear() {
      sent.length = 0;
    },
  });
}

/**
 * A browser's side of a push subscription, made in the test: a fresh endpoint
 * and key pair to give to `subscribeWebPush`, and `decrypt` to read what
 * `fakePushTransport` recorded for it.
 */
export async function fakePushSubscription(
  options: { endpoint?: string } = {},
) {
  const receiver = await createReceiver();
  const endpoint =
    options.endpoint ??
    `https://fcm.googleapis.com/fcm/send/${toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)))}`;
  return {
    endpoint,
    keys: receiver.keys,
    /** The shape `PushSubscription.toJSON()` returns. */
    toJSON: () => ({ endpoint, keys: { ...receiver.keys } }),
    /** Decrypts a recorded send (or its body) into the payload the browser would see. */
    async decrypt(sent: RecordedPush | Uint8Array): Promise<PushPayload> {
      const body = sent instanceof Uint8Array ? sent : sent.body;
      const plaintext = await decryptPushMessage(body, receiver);
      return JSON.parse(new TextDecoder().decode(plaintext)) as PushPayload;
    },
  };
}
