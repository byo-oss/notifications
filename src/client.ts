import type { BetterAuthClientPlugin } from "better-auth/client";
import type { inbox } from "./index";

/**
 * A browser `PushSubscription`, or its `toJSON()`. Typed by shape so this
 * entry never touches `navigator` or needs the DOM types: the app asks the
 * browser for a subscription (with the `vapidPublicKey` from `webPushStatus`
 * as `applicationServerKey`) and hands the result here.
 */
export type WebPushSubscriptionLike =
  | {
      endpoint: string;
      keys?: { p256dh?: string; auth?: string } | undefined;
    }
  | {
      toJSON(): {
        endpoint?: string | undefined;
        keys?: { p256dh?: string; auth?: string } | undefined;
      };
    };

function subscriptionBody(subscription: WebPushSubscriptionLike) {
  const json =
    "toJSON" in subscription ? subscription.toJSON() : subscription;
  return {
    endpoint: json.endpoint ?? "",
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

const endpointOf = (subscription: WebPushSubscriptionLike) =>
  subscriptionBody(subscription).endpoint;

export const inboxClient = () => {
  return {
    id: "inbox",
    $InferServerPlugin: {} as ReturnType<typeof inbox>,
    pathMethods: {
      "/inbox/list": "GET",
      "/inbox/unread-count": "GET",
      "/inbox/mark-read": "POST",
      "/inbox/mark-seen": "POST",
      "/inbox/mark-all-read": "POST",
      // web push, present when the server sets inbox({ webPush })
      "/inbox/push/subscribe": "POST",
      "/inbox/push/unsubscribe": "POST",
      "/inbox/push/status": "POST",
    },
    // Thin wrappers over the web push endpoints (server option `webPush`).
    getActions: ($fetch) => ({
      /** Saves a browser subscription for the signed-in user. */
      subscribeWebPush: (subscription: WebPushSubscriptionLike) =>
        $fetch<{ subscribed: true }>("/inbox/push/subscribe", {
          method: "POST",
          body: subscriptionBody(subscription),
        }),
      /** Removes the signed-in user's subscription for this endpoint. */
      unsubscribeWebPush: (subscription: WebPushSubscriptionLike) =>
        $fetch<{ removed: number }>("/inbox/push/unsubscribe", {
          method: "POST",
          body: { endpoint: endpointOf(subscription) },
        }),
      /**
       * The VAPID public key to subscribe with, whether the user has a device,
       * and, given a subscription, whether that one is saved.
       */
      webPushStatus: (subscription?: WebPushSubscriptionLike) =>
        $fetch<{
          vapidPublicKey: string;
          subscribed: boolean;
          endpointRegistered: boolean | null;
        }>("/inbox/push/status", {
          method: "POST",
          body: subscription ? { endpoint: endpointOf(subscription) } : {},
        }),
    }),
  } satisfies BetterAuthClientPlugin;
};

export type { Notification } from "./schema";
