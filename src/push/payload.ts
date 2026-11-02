import type { Notification } from "../schema";
import { MAX_PLAINTEXT_BYTES } from "./crypto";
import { utf8 } from "./encoding";

/**
 * The only things the library puts in a push message. Anything else a
 * notification carries (`type`, `data`, `organizationId`) stays on the server.
 */
export type PushPayload = {
  title: string;
  body?: string;
  /** An in-app path, such as `/chat/123`. Never an absolute URL to another site. */
  href?: string;
  /** The notification's id. */
  id: string;
};

const MAX_TITLE = 150;
const MAX_BODY = 500;
const MAX_HREF = 1024;

function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * Reduces a notification's `href` to a path inside the app. A relative path is
 * kept (given a leading slash). An absolute URL is kept as its path only when
 * it points at `appUrl`'s origin; any other absolute URL, and `//host` forms,
 * are dropped, so a message can't send a click to another site.
 */
export function inAppPath(
  href: string | null | undefined,
  appUrl: string | undefined,
): string | undefined {
  if (!href) return undefined;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    let url: URL;
    let app: URL;
    try {
      url = new URL(href);
      app = new URL(appUrl ?? "");
    } catch {
      return undefined;
    }
    if (url.origin !== app.origin) return undefined;
    path = `${url.pathname}${url.search}${url.hash}`;
  } else {
    path = href.startsWith("/") ? href : `/${href}`;
  }
  if (path.startsWith("//") || path.startsWith("/\\") || /[\u0000-\u001f]/.test(path)) {
    return undefined;
  }
  return [...path].length > MAX_HREF ? undefined : path;
}

const encode = (payload: PushPayload) => utf8(JSON.stringify(payload));

/**
 * The JSON plaintext for one notification, at most 3993 bytes (the most one
 * RFC 8291 record holds). Long text is cut at a code point, then if the
 * message is still too large the link, then the body, then more of the title
 * go.
 */
export function buildPayload(
  notification: Pick<Notification, "id" | "title" | "body" | "href">,
  appUrl: string | undefined,
): Uint8Array {
  const payload: PushPayload = {
    title: truncate(notification.title, MAX_TITLE),
    id: notification.id,
  };
  if (notification.body) payload.body = truncate(notification.body, MAX_BODY);
  const href = inAppPath(notification.href, appUrl);
  if (href) payload.href = href;

  let bytes = encode(payload);
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    delete payload.href;
    bytes = encode(payload);
  }
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    delete payload.body;
    bytes = encode(payload);
  }
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    payload.title = truncate(payload.title, 40);
    bytes = encode(payload);
  }
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError("push message is too large");
  }
  return bytes;
}
