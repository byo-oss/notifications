import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVapidSigner,
  deriveKeys,
  encryptPushMessage,
  generateVapidKeys,
  MAX_PLAINTEXT_BYTES,
  signVapidJwt,
  validateVapid,
  VAPID_TOKEN_SECONDS,
} from "./crypto";
import { decryptPushMessage } from "./decrypt";
import { fromBase64Url, toBase64Url, utf8 } from "./encoding";

// No test in this file may reach the network.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("fetch must not be called in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

// RFC 8291 section 5 and Appendix A. The RFC prints these wrapped, with
// spaces; whitespace is not part of the value.
const rfc = (value: string) => value.replace(/\s+/g, "");
const bytes = (value: string) => {
  const decoded = fromBase64Url(rfc(value));
  if (!decoded) throw new Error("bad test vector");
  return decoded;
};

const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ",
  // section 5: the whole request body
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

const ecdhKey = (privateKey: string, publicKey: string) =>
  crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: rfc(privateKey),
      x: toBase64Url(bytes(publicKey).slice(1, 33)),
      y: toBase64Url(bytes(publicKey).slice(33, 65)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

describe("RFC 8291 Appendix A", () => {
  it("decodes the plaintext the RFC encrypts", () => {
    expect(new TextDecoder().decode(bytes(V.plaintext))).toBe(
      "When I grow up, I want to be a watermelon",
    );
  });

  it("derives the RFC's intermediate values from the sender side", async () => {
    const keys = await deriveKeys({
      privateKey: await ecdhKey(V.asPrivate, V.asPublic),
      peerPublic: bytes(V.uaPublic),
      uaPublic: bytes(V.uaPublic),
      asPublic: bytes(V.asPublic),
      authSecret: bytes(V.auth),
      salt: bytes(V.salt),
    });
    expect(toBase64Url(keys.ecdhSecret)).toBe(V.ecdhSecret);
    expect(toBase64Url(keys.ikm)).toBe(V.ikm);
    expect(toBase64Url(keys.cek)).toBe(V.cek);
    expect(toBase64Url(keys.nonce)).toBe(V.nonce);
  });

  it("derives the same values from the receiver side", async () => {
    const keys = await deriveKeys({
      privateKey: await ecdhKey(V.uaPrivate, V.uaPublic),
      peerPublic: bytes(V.asPublic),
      uaPublic: bytes(V.uaPublic),
      asPublic: bytes(V.asPublic),
      authSecret: bytes(V.auth),
      salt: bytes(V.salt),
    });
    expect(toBase64Url(keys.cek)).toBe(V.cek);
    expect(toBase64Url(keys.nonce)).toBe(V.nonce);
  });

  it("encrypts to the RFC's header and ciphertext, byte for byte", async () => {
    const body = await encryptPushMessage({
      plaintext: bytes(V.plaintext),
      p256dh: bytes(V.uaPublic),
      auth: bytes(V.auth),
      fixed: {
        privateKey: bytes(V.asPrivate),
        publicKey: bytes(V.asPublic),
        salt: bytes(V.salt),
      },
    });
    expect(toBase64Url(body.slice(0, 86))).toBe(rfc(V.header));
    expect(toBase64Url(body.slice(86))).toBe(rfc(V.ciphertext));
    expect(toBase64Url(body)).toBe(rfc(V.body));
    // 86 header + 41 plaintext + 1 delimiter + 16 tag. The RFC's example says
    // "Content-Length: 145", which doesn't match its own body (a known erratum)
    expect(body).toHaveLength(144);
  });

  it("decrypts the RFC's section 5 body with the receiver's keys", async () => {
    const plaintext = await decryptPushMessage(bytes(V.body), {
      privateKey: await ecdhKey(V.uaPrivate, V.uaPublic),
      p256dh: bytes(V.uaPublic),
      auth: bytes(V.auth),
    });
    expect(new TextDecoder().decode(plaintext)).toBe(
      "When I grow up, I want to be a watermelon",
    );
  });
});

describe("encryptPushMessage", () => {
  const receiver = async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    return {
      privateKey: pair.privateKey,
      p256dh: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      auth: crypto.getRandomValues(new Uint8Array(16)),
    };
  };

  it("uses a fresh sender key and salt every time and round-trips", async () => {
    const r = await receiver();
    const text = utf8('{"title":"Hello"}');
    const a = await encryptPushMessage({ plaintext: text, p256dh: r.p256dh, auth: r.auth });
    const b = await encryptPushMessage({ plaintext: text, p256dh: r.p256dh, auth: r.auth });
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16)));
    expect(await decryptPushMessage(a, r)).toEqual(text);
  });

  it("carries 3993 bytes and fits the 4096-byte limit exactly", async () => {
    expect(MAX_PLAINTEXT_BYTES).toBe(3993);
    const r = await receiver();
    const text = new Uint8Array(MAX_PLAINTEXT_BYTES).fill(0x61);
    const body = await encryptPushMessage({ plaintext: text, p256dh: r.p256dh, auth: r.auth });
    expect(body.length).toBe(4096);
    expect(await decryptPushMessage(body, r)).toEqual(text);
  });

  it("refuses 3994 bytes", async () => {
    const r = await receiver();
    await expect(
      encryptPushMessage({
        plaintext: new Uint8Array(MAX_PLAINTEXT_BYTES + 1),
        p256dh: r.p256dh,
        auth: r.auth,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("refuses a bad auth secret and a point that isn't on the curve", async () => {
    const r = await receiver();
    await expect(
      encryptPushMessage({ plaintext: utf8("x"), p256dh: r.p256dh, auth: new Uint8Array(8) }),
    ).rejects.toThrow();
    const offCurve = new Uint8Array(65).fill(1);
    offCurve[0] = 4;
    await expect(
      encryptPushMessage({ plaintext: utf8("x"), p256dh: offCurve, auth: r.auth }),
    ).rejects.toThrow();
  });
});

// RFC 8292 section 2.4
const RFC8292 = {
  jwt: rfc(`eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3
        B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1ha
        Wx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_H
        LGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA`),
  publicKey: rfc(`BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dR
        uU_RCPCfA5aq9ojSwk5Y2EmClBPs`),
};

const decodeJson = (part: string) =>
  JSON.parse(new TextDecoder().decode(fromBase64Url(part)!));

describe("VAPID (RFC 8292)", () => {
  it("accepts the RFC's example token under its published public key", async () => {
    const [header, claims, signature] = RFC8292.jwt.split(".") as [string, string, string];
    expect(decodeJson(header)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decodeJson(claims)).toEqual({
      aud: "https://push.example.net",
      exp: 1453523768,
      sub: "mailto:push@example.com",
    });
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(RFC8292.publicKey)!,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(signature)!,
      utf8(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("serializes the header and claims exactly as the RFC example does", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const jwt = await signVapidJwt(pair.privateKey, {
      aud: "https://push.example.net",
      exp: 1453523768,
      sub: "mailto:push@example.com",
    });
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    const [rfcHeader, rfcClaims] = RFC8292.jwt.split(".");
    expect(header).toBe(rfcHeader);
    expect(claims).toBe(rfcClaims);
    expect(fromBase64Url(signature)).toHaveLength(64); // raw r || s, not DER
  });

  describe("createVapidSigner", () => {
    const subject = "mailto:ops@example.test";

    it("signs a token whose aud is the endpoint's origin and exp is within 24 hours", async () => {
      const keys = await generateVapidKeys();
      const signer = await createVapidSigner({ subject, ...keys });
      const now = Date.UTC(2026, 10, 2, 12, 0, 0);
      const header = await signer.authorization(
        new URL("https://fcm.googleapis.com/fcm/send/abc?x=1"),
        now,
      );

      const match = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
      expect(match).not.toBeNull();
      const [, jwt, k] = match as unknown as [string, string, string];
      expect(k).toBe(keys.publicKey);
      const [h, c, s] = jwt.split(".") as [string, string, string];
      const claims = decodeJson(c);
      expect(claims).toEqual({
        aud: "https://fcm.googleapis.com",
        exp: Math.floor(now / 1000) + VAPID_TOKEN_SECONDS,
        sub: subject,
      });
      expect(claims.exp - Math.floor(now / 1000)).toBeLessThanOrEqual(24 * 3600);
      expect(claims.exp).toBeGreaterThan(Math.floor(now / 1000));

      const publicKey = await crypto.subtle.importKey(
        "raw",
        fromBase64Url(keys.publicKey)!,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          fromBase64Url(s)!,
          utf8(`${h}.${c}`),
        ),
      ).toBe(true);
    });

    it("uses the origin for an endpoint on a different host", async () => {
      const keys = await generateVapidKeys();
      const signer = await createVapidSigner({ subject, ...keys });
      const header = await signer.authorization(
        new URL("https://web.push.apple.com/QGxm"),
      );
      const claims = decodeJson(/t=([^.]+\.[^.]+)\./.exec(header)![1]!.split(".")[1]!);
      expect(claims.aud).toBe("https://web.push.apple.com");
    });

    it("gives the same keyId for the same public key and a different one for another", async () => {
      const a = await generateVapidKeys();
      const b = await generateVapidKeys();
      const first = await createVapidSigner({ subject, ...a });
      const again = await createVapidSigner({ subject, ...a });
      const other = await createVapidSigner({ subject, ...b });
      expect(first.keyId).toBe(again.keyId);
      expect(first.keyId).not.toBe(other.keyId);
      expect(first.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it("rejects a private key that belongs to another public key", async () => {
      const a = await generateVapidKeys();
      const b = await generateVapidKeys();
      await expect(
        createVapidSigner({ subject, publicKey: a.publicKey, privateKey: b.privateKey }),
      ).rejects.toThrow(/does not belong/);
    });
  });

  describe("validateVapid", () => {
    it("names the problem without printing a key", async () => {
      const keys = await generateVapidKeys();
      const subject = "mailto:ops@example.test";
      expect(validateVapid({ subject, ...keys })).toBeNull();
      expect(validateVapid({ subject: "https://example.test/contact", ...keys })).toBeNull();
      const bad = [
        { subject, publicKey: "short", privateKey: keys.privateKey },
        { subject, publicKey: keys.publicKey, privateKey: keys.publicKey },
        { subject: "ops@example.test", ...keys },
        { subject: "http://example.test", ...keys },
      ];
      for (const vapid of bad) {
        const message = validateVapid(vapid);
        expect(message).toMatch(/^vapid\./);
        expect(message).not.toContain(keys.privateKey);
        expect(message).not.toContain(keys.publicKey);
      }
    });
  });

  it("generates a 65-byte public and 32-byte private key", async () => {
    const keys = await generateVapidKeys();
    expect(fromBase64Url(keys.publicKey)).toHaveLength(65);
    expect(fromBase64Url(keys.publicKey)![0]).toBe(4);
    expect(fromBase64Url(keys.privateKey)).toHaveLength(32);
  });
});
