import { describe, expect, it } from "vitest";
import { MAX_PLAINTEXT_BYTES } from "./crypto";
import { buildPayload, inAppPath } from "./payload";

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const base = { id: "n_1", title: "Your briefing is ready", body: null, href: null };

describe("buildPayload", () => {
  it("carries a title, an optional body, a link and an id, and nothing else", () => {
    const payload = decode(
      buildPayload(
        { ...base, body: "Open it", href: "/chat/1" },
        "https://app.test",
      ),
    );
    expect(payload).toEqual({
      title: "Your briefing is ready",
      body: "Open it",
      href: "/chat/1",
      id: "n_1",
    });
  });

  it("leaves out body and href when the notification has none", () => {
    expect(decode(buildPayload(base, undefined))).toEqual({
      title: "Your briefing is ready",
      id: "n_1",
    });
  });

  it("never copies type, data, organizationId or userId", () => {
    const notification = {
      ...base,
      type: "eve.briefing_ready",
      data: { secret: "do not send" },
      organizationId: "org_1",
      userId: "u_1",
    };
    const text = new TextDecoder().decode(buildPayload(notification, undefined));
    expect(text).not.toContain("do not send");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["id", "title"]);
  });

  it("stays at or under 3993 bytes whatever it is given, cutting at code points", () => {
    const emoji = "\u{1F600}".repeat(6000);
    for (const text of [emoji, "a".repeat(100_000), "\u0001".repeat(5000), "é".repeat(5000)]) {
      const bytes = buildPayload(
        { id: "n".repeat(36), title: text, body: text, href: `/x/${"y".repeat(900)}` },
        undefined,
      );
      expect(bytes.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
      const payload = decode(bytes); // still valid JSON, no split surrogate
      expect(payload.title).not.toMatch(/�/);
    }
  });

  it("shortens a long title and body with an ellipsis", () => {
    const payload = decode(
      buildPayload({ ...base, title: "T".repeat(400), body: "B".repeat(2000) }, undefined),
    );
    expect([...payload.title]).toHaveLength(150);
    expect(payload.title.endsWith("…")).toBe(true);
    expect([...payload.body]).toHaveLength(500);
  });
});

describe("inAppPath", () => {
  const app = "https://app.example.test";
  it("keeps a relative path and adds a missing slash", () => {
    expect(inAppPath("/chat/1?n=2#top", app)).toBe("/chat/1?n=2#top");
    expect(inAppPath("inbox", app)).toBe("/inbox");
  });
  it("reduces an absolute URL on the app's origin to its path", () => {
    expect(inAppPath("https://app.example.test/chat/1?a=b", app)).toBe("/chat/1?a=b");
  });
  it("drops every link that would leave the app", () => {
    for (const href of [
      "https://elsewhere.test/x",
      "//elsewhere.test/x",
      "/\\elsewhere.test",
      "javascript:alert(1)",
      "data:text/html,x",
      "http://app.example.test/x", // another origin: wrong scheme
      "",
    ]) {
      expect(inAppPath(href, app), href).toBeUndefined();
    }
    expect(inAppPath("https://app.example.test/x", undefined)).toBeUndefined();
  });
  it("drops control characters and overlong paths", () => {
    expect(inAppPath("/a\nb", app)).toBeUndefined();
    expect(inAppPath(`/${"a".repeat(1100)}`, app)).toBeUndefined();
  });
});
