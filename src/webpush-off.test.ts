import { getAuthTables } from "@better-auth/core/db";
import { describe, expect, it } from "vitest";
import { inbox } from "./index";
import { createTestAuth } from "./test-utils";

// What `inbox()` looked like in 0.11.4. Without the `webPush` option none of
// this may change: no new tables, no new fields, no new routes, no new keys.
describe("inbox() without webPush", () => {
  it("creates only the three 0.11 tables", () => {
    const tables = getAuthTables({ plugins: [inbox()] });
    const own = Object.fromEntries(
      Object.entries(tables)
        .filter(([model]) =>
          ["notification", "notificationDelivery", "inboxPresence", "pushSubscription"].includes(model),
        )
        .map(([model, table]) => [
          model,
          Object.fromEntries(
            Object.entries(table.fields).map(([name, field]) => [
              name,
              {
                type: field.type,
                required: field.required ?? null,
                unique: field.unique ?? null,
                references: field.references ?? null,
              },
            ]),
          ),
        ]),
    );
    expect(own).toMatchInlineSnapshot(`
      {
        "inboxPresence": {
          "lastSeenAt": {
            "references": null,
            "required": true,
            "type": "date",
            "unique": null,
          },
          "userId": {
            "references": {
              "field": "id",
              "model": "user",
              "onDelete": "cascade",
            },
            "required": true,
            "type": "string",
            "unique": true,
          },
        },
        "notification": {
          "body": {
            "references": null,
            "required": false,
            "type": "string",
            "unique": null,
          },
          "createdAt": {
            "references": null,
            "required": true,
            "type": "date",
            "unique": null,
          },
          "data": {
            "references": null,
            "required": false,
            "type": "json",
            "unique": null,
          },
          "href": {
            "references": null,
            "required": false,
            "type": "string",
            "unique": null,
          },
          "organizationId": {
            "references": null,
            "required": false,
            "type": "string",
            "unique": null,
          },
          "read": {
            "references": null,
            "required": true,
            "type": "boolean",
            "unique": null,
          },
          "seenAt": {
            "references": null,
            "required": false,
            "type": "date",
            "unique": null,
          },
          "title": {
            "references": null,
            "required": true,
            "type": "string",
            "unique": null,
          },
          "type": {
            "references": null,
            "required": true,
            "type": "string",
            "unique": null,
          },
          "userId": {
            "references": {
              "field": "id",
              "model": "user",
              "onDelete": "cascade",
            },
            "required": true,
            "type": "string",
            "unique": null,
          },
        },
        "notificationDelivery": {
          "attempts": {
            "references": null,
            "required": true,
            "type": "number",
            "unique": null,
          },
          "channel": {
            "references": null,
            "required": true,
            "type": "string",
            "unique": null,
          },
          "claimedAt": {
            "references": null,
            "required": false,
            "type": "date",
            "unique": null,
          },
          "createdAt": {
            "references": null,
            "required": true,
            "type": "date",
            "unique": null,
          },
          "detail": {
            "references": null,
            "required": false,
            "type": "string",
            "unique": null,
          },
          "notificationId": {
            "references": {
              "field": "id",
              "model": "notification",
              "onDelete": "cascade",
            },
            "required": true,
            "type": "string",
            "unique": null,
          },
          "scheduledFor": {
            "references": null,
            "required": true,
            "type": "date",
            "unique": null,
          },
          "sentAt": {
            "references": null,
            "required": false,
            "type": "date",
            "unique": null,
          },
          "status": {
            "references": null,
            "required": true,
            "type": "string",
            "unique": null,
          },
          "type": {
            "references": null,
            "required": true,
            "type": "string",
            "unique": null,
          },
          "userId": {
            "references": {
              "field": "id",
              "model": "user",
              "onDelete": "cascade",
            },
            "required": true,
            "type": "string",
            "unique": null,
          },
        },
      }
    `);
  });

  it("exposes the same endpoints", () => {
    const endpoints = Object.fromEntries(
      Object.entries(inbox().endpoints).map(([key, endpoint]) => [
        key,
        {
          path: (endpoint as { path?: string }).path ?? null,
          method: (endpoint as { options?: { method?: string } }).options?.method ?? null,
        },
      ]),
    );
    expect(endpoints).toMatchInlineSnapshot(`
      {
        "listNotifications": {
          "method": "GET",
          "path": "/inbox/list",
        },
        "markAllRead": {
          "method": "POST",
          "path": "/inbox/mark-all-read",
        },
        "markRead": {
          "method": "POST",
          "path": "/inbox/mark-read",
        },
        "markSeen": {
          "method": "POST",
          "path": "/inbox/mark-seen",
        },
        "notify": {
          "method": "POST",
          "path": null,
        },
        "processDeliveries": {
          "method": "POST",
          "path": null,
        },
        "unreadCount": {
          "method": "GET",
          "path": "/inbox/unread-count",
        },
      }
    `);
  });

  it("adds the same auth.api keys and no push route", async () => {
    const auth = createTestAuth();
    expect(Object.keys(auth.api).filter((key) => /notif|inbox|push|unread|mark|deliver/i.test(key)).sort()).toMatchInlineSnapshot(`
      [
        "listNotifications",
        "markAllRead",
        "markRead",
        "markSeen",
        "notify",
        "processDeliveries",
        "unreadCount",
      ]
    `);
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/inbox/push/status", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });
});
