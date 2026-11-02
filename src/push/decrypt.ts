// The receiving side of RFC 8291, for tests: what a browser's push service
// does with a message. Imported only by `./testing`, never by the server entry.
import { toBase64Url } from "./encoding";
import { deriveKeys, P256_PUBLIC_LENGTH } from "./crypto";

const subtle = () => globalThis.crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export type FakeSubscriptionKeys = {
  /** Base64url, goes in the subscription's `keys.p256dh`. */
  p256dh: string;
  /** Base64url, goes in the subscription's `keys.auth`. */
  auth: string;
};

/** Decrypts one aes128gcm push message with a receiver's private key and auth secret. */
export async function decryptPushMessage(
  body: Uint8Array,
  receiver: { privateKey: CryptoKey; p256dh: Uint8Array; auth: Uint8Array },
): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  if (idLength !== P256_PUBLIC_LENGTH) throw new Error("unexpected keyid length");
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const { cek, nonce } = await deriveKeys({
    privateKey: receiver.privateKey,
    peerPublic: asPublic,
    uaPublic: receiver.p256dh,
    asPublic,
    authSecret: receiver.auth,
    salt,
  });
  const aes = await subtle().importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aes,
      ciphertext as BufferSource,
    ),
  );
  // strip the padding delimiter: trailing zeros, then the 0x02 of the last record
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  if (record[end - 1] !== 2) throw new Error("missing last-record delimiter");
  return record.slice(0, end - 1);
}

/** A new receiver key pair and auth secret, as a browser makes for a subscription. */
export async function createReceiver() {
  const pair = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  const p256dh = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    p256dh,
    auth,
    keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) } satisfies FakeSubscriptionKeys,
  };
}
