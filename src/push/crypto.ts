// Web Push message encryption (RFC 8291, the aes128gcm content coding of RFC
// 8188) and VAPID (RFC 8292), on WebCrypto only. No Node crypto, no `web-push`
// package, so this runs on Node, Bun, Cloudflare Workers/D1 and browsers.
import { concat, fromBase64Url, toBase64Url, utf8 } from "./encoding";

const subtle = () => globalThis.crypto.subtle;

export const P256_PUBLIC_LENGTH = 65;
export const P256_PRIVATE_LENGTH = 32;
export const AUTH_SECRET_LENGTH = 16;
const SALT_LENGTH = 16;
const RECORD_SIZE = 4096;
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + P256_PUBLIC_LENGTH; // 86
const TAG_LENGTH = 16;
/** The most plaintext one message can carry: 4096 - 86 (header) - 16 (tag) - 1 (delimiter). */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_LENGTH - TAG_LENGTH - 1; // 3993

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

const isUncompressedPoint = (bytes: Uint8Array) =>
  bytes.length === P256_PUBLIC_LENGTH && bytes[0] === 0x04;

/** A P-256 private key as a JWK, from its raw scalar and its uncompressed public point. */
function privateJwk(privateKey: Uint8Array, publicKey: Uint8Array): JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    d: toBase64Url(privateKey),
    x: toBase64Url(publicKey.slice(1, 33)),
    y: toBase64Url(publicKey.slice(33, 65)),
    ext: true,
  };
}

const importEcdhPublic = (raw: Uint8Array) =>
  subtle().importKey("raw", raw as BufferSource, ECDH, false, []);

/**
 * Checks that bytes are a P-256 public key on the curve (the import fails for a
 * point that isn't). Used before a subscription is stored.
 */
export async function isValidP256Public(raw: Uint8Array): Promise<boolean> {
  if (!isUncompressedPoint(raw)) return false;
  try {
    await importEcdhPublic(raw);
    return true;
  } catch {
    return false;
  }
}

async function hkdf(
  secret: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey(
    "raw",
    secret as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await subtle().deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt as BufferSource,
        info: info as BufferSource,
      },
      key,
      bits,
    ),
  );
}

export type DerivedKeys = {
  /** The raw ECDH shared secret. */
  ecdhSecret: Uint8Array;
  /** Input keying material (RFC 8291 section 3.3). */
  ikm: Uint8Array;
  /** Content encryption key, 16 bytes. */
  cek: Uint8Array;
  /** Nonce, 12 bytes. */
  nonce: Uint8Array;
};

/**
 * RFC 8291 section 3.4 key schedule, run from either side: the sender passes
 * its private key with the receiver's public key, the receiver the reverse.
 */
export async function deriveKeys(input: {
  privateKey: CryptoKey;
  peerPublic: Uint8Array;
  uaPublic: Uint8Array;
  asPublic: Uint8Array;
  authSecret: Uint8Array;
  salt: Uint8Array;
}): Promise<DerivedKeys> {
  const ecdhSecret = new Uint8Array(
    await subtle().deriveBits(
      { name: "ECDH", public: await importEcdhPublic(input.peerPublic) },
      input.privateKey,
      256,
    ),
  );
  const keyInfo = concat(
    utf8("WebPush: info\0"),
    input.uaPublic,
    input.asPublic,
  );
  const ikm = await hkdf(ecdhSecret, input.authSecret, keyInfo, 256);
  const cek = await hkdf(ikm, input.salt, utf8("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, input.salt, utf8("Content-Encoding: nonce\0"), 96);
  return { ecdhSecret, ikm, cek, nonce };
}

export type EncryptInput = {
  plaintext: Uint8Array;
  /** The subscription's `p256dh`: the receiver's uncompressed P-256 public key. */
  p256dh: Uint8Array;
  /** The subscription's `auth`: the 16-byte authentication secret. */
  auth: Uint8Array;
  /** Fixed sender key and salt, for the RFC's test vector only. Omit in production. */
  fixed?: { privateKey: Uint8Array; publicKey: Uint8Array; salt: Uint8Array };
};

/**
 * Encrypts one push message into a single aes128gcm record (RFC 8291 + RFC
 * 8188): header (salt, record size, sender public key) then ciphertext. A fresh
 * sender key pair and salt are generated per call.
 */
export async function encryptPushMessage(
  input: EncryptInput,
): Promise<Uint8Array<ArrayBuffer>> {
  if (input.plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError("push message plaintext is too large");
  }
  if (!isUncompressedPoint(input.p256dh)) {
    throw new TypeError("p256dh is not an uncompressed P-256 point");
  }
  if (input.auth.length !== AUTH_SECRET_LENGTH) {
    throw new TypeError("auth secret must be 16 bytes");
  }

  let privateKey: CryptoKey;
  let asPublic: Uint8Array;
  let salt: Uint8Array;
  if (input.fixed) {
    asPublic = input.fixed.publicKey;
    salt = input.fixed.salt;
    privateKey = await subtle().importKey(
      "jwk",
      privateJwk(input.fixed.privateKey, input.fixed.publicKey),
      ECDH,
      false,
      ["deriveBits"],
    );
  } else {
    const pair = await subtle().generateKey(ECDH, true, ["deriveBits"]);
    privateKey = pair.privateKey;
    asPublic = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
    salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  }

  const { cek, nonce } = await deriveKeys({
    privateKey,
    peerPublic: input.p256dh,
    uaPublic: input.p256dh,
    asPublic,
    authSecret: input.auth,
    salt,
  });
  const aes = await subtle().importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 marks the last (here the only) record
  const record = concat(input.plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aes,
      record as BufferSource,
    ),
  );
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(
    salt,
    rs,
    new Uint8Array([asPublic.length]),
    asPublic,
    ciphertext,
  );
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)

export type VapidConfig = {
  /** A `mailto:` or `https:` contact URI for the push service to reach you. */
  subject: string;
  /** Base64url, the 65-byte uncompressed P-256 public key. */
  publicKey: string;
  /** Base64url, the 32-byte P-256 private scalar. */
  privateKey: string;
};

/** Lifetime of a signed token. RFC 8292 caps `exp` at 24 hours; this stays well under. */
export const VAPID_TOKEN_SECONDS = 12 * 60 * 60;

const base64UrlJson = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));

/** The JWT of RFC 8292 section 2: `{ aud, exp, sub }`, signed ES256. */
export async function signVapidJwt(
  privateKey: CryptoKey,
  claims: { aud: string; exp: number; sub: string },
): Promise<string> {
  const signingInput = `${base64UrlJson({ typ: "JWT", alg: "ES256" })}.${base64UrlJson(claims)}`;
  // WebCrypto returns ECDSA signatures as raw r || s, which is what JWS ES256 wants
  const signature = new Uint8Array(
    await subtle().sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      utf8(signingInput) as BufferSource,
    ),
  );
  return `${signingInput}.${toBase64Url(signature)}`;
}

export type VapidSigner = {
  /** Base64url public key, as sent in the `k` parameter and given to `subscribe`. */
  publicKey: string;
  /** A short stable id of the public key, stored on each subscription. */
  keyId: string;
  /** The `Authorization` header value for a push resource at `endpoint`. */
  authorization(endpoint: URL, nowMs?: number): Promise<string>;
};

/** Syntax check for the VAPID config. Never includes a key in the message. */
export function validateVapid(vapid: VapidConfig): string | null {
  const publicKey = fromBase64Url(vapid.publicKey ?? "");
  if (!publicKey || !isUncompressedPoint(publicKey)) {
    return "vapid.publicKey must be a base64url 65-byte uncompressed P-256 public key";
  }
  const privateKey = fromBase64Url(vapid.privateKey ?? "");
  if (!privateKey || privateKey.length !== P256_PRIVATE_LENGTH) {
    return "vapid.privateKey must be a base64url 32-byte P-256 private key";
  }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+\S*)$/.test(vapid.subject ?? "")) {
    return "vapid.subject must be a mailto: or https: URI";
  }
  return null;
}

/** The id stored on a subscription: the first 16 bytes of SHA-256 of the public key, base64url. */
export async function vapidKeyId(publicKey: string): Promise<string> {
  const bytes = fromBase64Url(publicKey) ?? utf8(publicKey);
  const digest = new Uint8Array(
    await subtle().digest("SHA-256", bytes as BufferSource),
  );
  return toBase64Url(digest.slice(0, 16));
}

/**
 * Imports the VAPID key pair (validated first with `validateVapid`) and proves
 * the two halves match, by signing a probe and verifying it. A mismatched pair
 * would get every push refused with 403, which deletes the subscription.
 */
export async function createVapidSigner(vapid: VapidConfig): Promise<VapidSigner> {
  const publicRaw = fromBase64Url(vapid.publicKey)!;
  const privateRaw = fromBase64Url(vapid.privateKey)!;
  const mismatch = () =>
    new Error(
      "[@byo-oss/notifications] webPush.vapid.privateKey does not belong to webPush.vapid.publicKey",
    );
  // WebCrypto refuses a private scalar that doesn't produce the public point
  const signKey = await subtle()
    .importKey("jwk", privateJwk(privateRaw, publicRaw), ECDSA, false, ["sign"])
    .catch(() => {
      throw mismatch();
    });
  const verifyKey = await subtle().importKey(
    "raw",
    publicRaw as BufferSource,
    ECDSA,
    false,
    ["verify"],
  );
  const probe = utf8("vapid key check");
  const signature = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    signKey,
    probe as BufferSource,
  );
  const matches = await subtle().verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    signature,
    probe as BufferSource,
  );
  if (!matches) throw mismatch();
  const publicKey = toBase64Url(publicRaw);
  return {
    publicKey,
    keyId: await vapidKeyId(publicKey),
    async authorization(endpoint, nowMs = Date.now()) {
      const jwt = await signVapidJwt(signKey, {
        aud: endpoint.origin,
        exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_SECONDS,
        sub: vapid.subject,
      });
      return `vapid t=${jwt}, k=${publicKey}`;
    },
  };
}

/** A fresh VAPID key pair, as base64url strings ready for `webPush.vapid`. */
export async function generateVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = await subtle().generateKey(ECDSA, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  const jwk = await subtle().exportKey("jwk", pair.privateKey);
  return { publicKey: toBase64Url(publicKey), privateKey: jwk.d! };
}
