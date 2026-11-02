import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransport } from "./transport";

afterEach(() => vi.unstubAllGlobals());

// The stub stands in for the network: the real fetch is never reachable here.
describe("fetchTransport", () => {
  it("posts the body with the headers, never follows a redirect, and sets a timeout", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 201 });
    });
    const body = new Uint8Array([1, 2, 3]);
    const result = await fetchTransport({
      url: "https://fcm.googleapis.com/fcm/send/x",
      method: "POST",
      headers: { TTL: "60" },
      body,
    });
    expect(result).toEqual({ status: 201 });
    const [url, init] = calls[0]!;
    expect(url).toBe("https://fcm.googleapis.com/fcm/send/x");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ TTL: "60" });
    expect(init.body).toBe(body);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a redirect's status instead of following it", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 307, headers: { location: "https://169.254.169.254/" } }));
    const result = await fetchTransport({
      url: "https://fcm.googleapis.com/x",
      method: "POST",
      headers: {},
      body: new Uint8Array(),
    });
    expect(result).toEqual({ status: 307 });
  });

  it("returns only the status, whatever the push service says in its body", async () => {
    vi.stubGlobal("fetch", async () => new Response("echo of the endpoint", { status: 410 }));
    const result = await fetchTransport({
      url: "https://fcm.googleapis.com/x",
      method: "POST",
      headers: {},
      body: new Uint8Array(),
    });
    expect(result).toEqual({ status: 410 });
  });
});
