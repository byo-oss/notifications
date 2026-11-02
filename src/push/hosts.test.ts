import { describe, expect, it } from "vitest";
import {
  checkEndpoint,
  DEFAULT_PUSH_HOSTS,
  MAX_ENDPOINT_LENGTH,
  validateAllowedHosts,
} from "./hosts";

const ok = (endpoint: string, hosts: readonly string[] = DEFAULT_PUSH_HOSTS) =>
  checkEndpoint(endpoint, hosts) !== null;

describe("checkEndpoint", () => {
  it("accepts the endpoints the major browsers hand out", () => {
    expect(ok("https://fcm.googleapis.com/fcm/send/abc:APA91b")).toBe(true);
    expect(ok("https://fcm.googleapis.com/wp/abc")).toBe(true);
    expect(ok("https://updates.push.services.mozilla.com/wpush/v2/gAAAA")).toBe(true);
    expect(ok("https://web.push.apple.com/QGxmN")).toBe(true);
    expect(ok("https://wns2-par02p.notify.windows.com/w/?token=BQYAAA")).toBe(true);
  });

  it("refuses anything that is not https", () => {
    expect(ok("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(ok("ftp://fcm.googleapis.com/x")).toBe(false);
    expect(ok("file:///etc/passwd")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
  });

  it("refuses internal and metadata addresses, however they are written", () => {
    for (const endpoint of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data",
      "https://2130706433/x", // 127.0.0.1 as a decimal
      "https://0x7f.1/x",
      "https://10.0.0.5/x",
      "https://metadata.google.internal/x",
    ]) {
      expect(ok(endpoint), endpoint).toBe(false);
    }
  });

  it("refuses hosts that only look like an allowed one", () => {
    expect(ok("https://fcm.googleapis.com.evil.test/x")).toBe(false);
    expect(ok("https://evil.test/fcm.googleapis.com")).toBe(false);
    expect(ok("https://notfcm.googleapis.com/x")).toBe(false);
    expect(ok("https://fcm.googleapis.com@evil.test/x")).toBe(false);
    expect(ok("https://evil.test#@fcm.googleapis.com/")).toBe(false);
    expect(ok("https://push.apple.com/x")).toBe(false); // *. needs a label
    expect(ok("https://evilpush.apple.com.test/x")).toBe(false);
    expect(ok("https://xpush.apple.com/x")).toBe(false);
    expect(ok("https://notify.windows.com/x")).toBe(false);
  });

  it("reads a backslash the way fetch does, so the host it checks is the host it calls", () => {
    // WHATWG treats \\ as / in https URLs: this is fcm.googleapis.com, path /@evil.test/
    const url = checkEndpoint("https://fcm.googleapis.com\\@evil.test/", DEFAULT_PUSH_HOSTS);
    expect(url?.hostname).toBe("fcm.googleapis.com");
    expect(url?.href).toBe("https://fcm.googleapis.com/@evil.test/");
    expect(ok("https://evil.test\\@fcm.googleapis.com/")).toBe(false);
  });

  it("refuses credentials, ports, trailing dots and overlong URLs", () => {
    expect(ok("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(ok("https://user@fcm.googleapis.com/x")).toBe(false);
    expect(ok("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(ok("https://fcm.googleapis.com:443/x")).toBe(true); // the default port
    expect(ok("https://fcm.googleapis.com./x")).toBe(false);
    expect(ok(`https://fcm.googleapis.com/${"a".repeat(MAX_ENDPOINT_LENGTH)}`)).toBe(false);
    expect(ok("not a url")).toBe(false);
    expect(ok("")).toBe(false);
    expect(checkEndpoint(undefined, DEFAULT_PUSH_HOSTS)).toBeNull();
    expect(checkEndpoint(42, DEFAULT_PUSH_HOSTS)).toBeNull();
  });

  it("matches case-insensitively, because the URL parser lowercases the host", () => {
    expect(ok("https://FCM.GoogleAPIs.com/x")).toBe(true);
  });

  it("uses a custom list instead of the defaults", () => {
    const hosts = ["push.example.test", "*.relay.example.test"];
    expect(ok("https://push.example.test/x", hosts)).toBe(true);
    expect(ok("https://a.relay.example.test/x", hosts)).toBe(true);
    expect(ok("https://relay.example.test/x", hosts)).toBe(false);
    expect(ok("https://fcm.googleapis.com/x", hosts)).toBe(false);
  });
});

describe("validateAllowedHosts", () => {
  it("accepts hostnames and *. wildcards", () => {
    expect(validateAllowedHosts(DEFAULT_PUSH_HOSTS)).toBeNull();
  });
  it("rejects an empty list, a bare wildcard, uppercase, schemes, paths and single labels", () => {
    for (const bad of [[], ["*"], ["*.com"], ["FCM.googleapis.com"], ["https://fcm.googleapis.com"], ["fcm.googleapis.com/x"], ["localhost"], [" fcm.googleapis.com"], ["*.*.example.test"]]) {
      expect(validateAllowedHosts(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});
