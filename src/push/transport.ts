/** One request to a push service's endpoint. */
export type PushRequest = {
  /** The subscription endpoint. A credential: never log it. */
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** The encrypted message. */
  body: Uint8Array;
};

/** What the library reads from a push service's answer: the status, nothing else. */
export type PushResponse = { status: number };

/**
 * Sends one request. Resolve with the status for any answer, including errors;
 * throw only when no answer came (network failure, timeout), which retries.
 * Must not follow redirects.
 */
export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

const REQUEST_TIMEOUT_MS = 15_000;

/** The default transport: `fetch`, no redirects, a timeout, and the body never read. */
export const fetchTransport: PushTransport = async (request) => {
  const response = await globalThis.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body as BodyInit,
    // a redirect would send the signed request somewhere the allow list never saw
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // push services answer with little or nothing useful; don't hold the socket
  void response.body?.cancel().catch(() => {});
  return { status: response.status };
};
