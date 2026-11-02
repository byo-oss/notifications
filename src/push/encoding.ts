// Base64url without padding (RFC 4648 section 5), the encoding Web Push uses
// for keys, salts and JWTs. Plain globals only (btoa/atob, TextEncoder), so it
// runs on Node, Bun, Workers and browsers.

export const utf8 = (text: string) => new TextEncoder().encode(text);

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Decodes unpadded (or padded) base64url. Returns null for anything else. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(value)) return null;
  const stripped = value.replace(/=+$/, "");
  if (stripped.length % 4 === 1) return null;
  try {
    const binary = atob(
      stripped.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (stripped.length % 4)) % 4),
    );
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
