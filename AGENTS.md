# @byo-oss/notifications

In-app notifications as a better-auth plugin (formerly `better-inbox`). `llms.txt` is the full usage reference; read it before wiring this into an app.

## Installing it in an app

The same steps, with checks, ship as a skill: `skills/byo-notifications/SKILL.md` (`npx skills add byo-oss/notifications`). Keep the two in step when setup changes.

1. `npm install @byo-oss/notifications @better-auth/core`. Requires better-auth 1.7.7+. Install `@better-auth/core` at the same version as `better-auth`.
2. Server: add `inbox()` to `betterAuth({ plugins })`, then run the app's migration (`npx @better-auth/cli migrate`, or regenerate drizzle/prisma).
3. Client: add `inboxClient()` from `@byo-oss/notifications/client` to `createAuthClient({ plugins })`.
4. UI: render `<InboxButton client={authClient} onNavigate={...} />` from `@byo-oss/notifications/react` once, in the app shell. Pass the router's navigate to `onNavigate`.
5. Tailwind v4: add `@source "<path>/node_modules/@byo-oss/notifications/dist";` to the CSS, or the components render unstyled.
6. Send with `auth.api.notify({ body })` from server code only. It is never an HTTP route.
7. With email routes: install `@byo-oss/mailer` and your provider's SDK (`@wraps.dev/email` for `wrapsMailer`), pass `mailerChannel({ mailer })` in `channels`, configure `channels` and `routes`, and call `auth.api.processDeliveries({})` from a cron every minute. Without the cron, delayed emails and retries never go out.
8. Events and core: pass `onEvent` built with `createEventBus` from `@byo-oss/core`; `sweepAll(auth)` may replace the `processDeliveries` cron. Events fire after the write commits. Of the calls that emit events, only `notify` joins a caller's `runWithTransaction` (its events wait for the commit, never fire on rollback). The sweep never joins one: its `delivery.failed` events fire at once, so call it outside a transaction.

## Web push

`inbox({ webPush })` is opt-in and must change nothing when unset: no table, no routes, no channel (`src/webpush-off.test.ts` snapshots that). The code is in `src/push/`: `crypto.ts` (RFC 8291 and VAPID on WebCrypto only, no Node crypto, no `web-push` package), `channel.ts` (the built-in `push` channel), `endpoints.ts`, `hosts.ts` (the SSRF allow list), `payload.ts`. `pushSubscription` rows are credentials: never log, return or export an endpoint, `p256dh` or `auth`, and never put one in an error message or `cause`, because the sweep stores and logs `error.message`. Titles and bodies are never logged. Docs: `docs/push.mdx` (inside `<Next>` until released).

## Events

`inbox({ onEvent })` receives these, after commit. `actorId` is always `null`; `organizationId` is set when the notification has one. No titles, bodies, hrefs, `data` or error text.

| type | userId | subject | data |
|---|---|---|---|
| `notifications.notification.created` | recipient | `{ type: "notification", id }` | `{ notificationId, notificationType }` |
| `notifications.delivery.failed` | recipient | `{ type: "notificationDelivery", id }` | `{ deliveryId, notificationId, notificationType, channel, attempts, reason }`; `reason` is `"permanent"`, `"max_attempts"` or `"unfinished"` |

`NOTIFICATIONS_EVENT_TYPES` exports the list; `src/events.test.ts` checks this table names every entry.

## Rules

- Address people by better-auth `userId`, organizations by `organizationId`. Don't keep a separate recipient table.
- Don't query or write the plugin's tables from app code. Go through `auth.api.*`, the hooks and the exported functions (`deleteOrganizationData`, `deleteMemberData`, `exportNotificationsData`).
- Never route `notifications.*` events into `notify`: it loops. `notify` rejects those types (`RESERVED_NOTIFICATION_TYPE`) and `routes` keys with that prefix throw at boot, but a forwarder that renames the type isn't caught.
- A custom channel is `{ deliver(ctx) }`: throw to retry, throw `PermanentDeliveryError` for sends that can never succeed, never mutate `ctx`. Test it with `testChannel` from `@byo-oss/notifications/testing`.

## Working on this repo

- `bun install`, then `bun run typecheck`, `bun run test`, `bun run build` and, after the build, `bun run test:dist` (scans `dist/` for what each entry imports).
- Tests run against a real better-auth instance on the memory adapter (`src/test-utils.ts`).
- Releases: bump `package.json`, merge, tag `v<version>`. The release workflow publishes through npm trusted publishing.
- Docs: `docs/*.mdx` is byo.dev/docs/notifications. A public change (exports, options, peer dependencies, documented behaviour) updates `docs/` in the same PR, inside `<Next>` until it's on npm. `docs/README.md` has the format.
- Follow the BYO conventions: https://github.com/byo-oss/conventions/blob/main/SPEC.md
