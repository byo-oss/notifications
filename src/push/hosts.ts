/**
 * The push services browsers use, by the host of the endpoint they hand out:
 * Chrome, Edge, Brave, Opera, Samsung Internet and Vivaldi (FCM), Firefox
 * (Mozilla autopush), Safari and iOS home-screen apps (Apple), and Edge on
 * Windows (WNS). A leading `*.` matches any subdomain, never the bare domain.
 */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
];

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** An endpoint longer than this is refused. Real ones are a few hundred characters. */
export const MAX_ENDPOINT_LENGTH = 2048;

/** Returns a message for the first bad pattern, or null. Never echoes a pattern's neighbours. */
export function validateAllowedHosts(hosts: readonly string[]): string | null {
  if (hosts.length === 0) return "webPush.allowedHosts must not be empty";
  for (const host of hosts) {
    if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
      return `webPush.allowedHosts entry "${String(host)}" must be a lowercase hostname such as "push.example.com" or "*.example.com"`;
    }
  }
  return null;
}

const hostMatches = (hostname: string, pattern: string) =>
  pattern.startsWith("*.")
    ? hostname.length > pattern.length - 1 && hostname.endsWith(pattern.slice(1))
    : hostname === pattern;

/**
 * The endpoint as a URL if it may be fetched, else null. The rules that keep a
 * signed-in caller from aiming the server at an internal address: https only,
 * no credentials in the URL, the default port, and a host on the allow list.
 * The WHATWG parser lowercases the host and turns numeric IP forms into
 * dotted ones, so an IP never matches a hostname pattern.
 */
export function checkEndpoint(
  endpoint: unknown,
  allowedHosts: readonly string[],
): URL | null {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (url.hostname.endsWith(".")) return null;
  if (!allowedHosts.some((pattern) => hostMatches(url.hostname, pattern))) {
    return null;
  }
  return url;
}
