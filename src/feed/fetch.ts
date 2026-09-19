const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export class FeedFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export interface FeedFetchResult {
  status: "not-modified" | "fetched";
  body: Uint8Array | null;
  contentType: string | null;
  finalUrl: string;
  permanentRedirectTarget: string | null;
  etag: string | null;
  lastModified: string | null;
}

const parseIpv4 = (hostname: string): number[] | null => {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return values;
};

const isBlockedIpv4 = (parts: number[]): boolean => {
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const normalizedHostname = (url: URL): string =>
  url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();

const isBlockedIpv6Literal = (hostname: string): boolean => {
  if (!hostname.includes(":")) return false;
  return (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb")
  );
};

export const assertSafeFeedUrl = (input: string | URL): URL => {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new FeedFetchError("invalid_url", "feed URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FeedFetchError("unsafe_target", "feed URL must use http or https");
  }

  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data" ||
    hostname === "169.254.169.254"
  ) {
    throw new FeedFetchError("unsafe_target", "feed target is not publicly routable");
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== null && isBlockedIpv4(ipv4)) {
    throw new FeedFetchError("unsafe_target", "feed target is not publicly routable");
  }

  if (isBlockedIpv6Literal(hostname)) {
    throw new FeedFetchError("unsafe_target", "feed target is not publicly routable");
  }

  return url;
};

const readBodyLimited = async (response: Response): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new FeedFetchError("response_too_large", "feed response exceeds 8 MiB limit");
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new FeedFetchError("response_too_large", "feed response exceeds 8 MiB limit");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    reader.releaseLock();
  }
};

const fetchWithTimeout = async (
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new FeedFetchError("timeout", "feed request exceeded 30 second timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const fetchFeedDocument = async (
  input: string,
  conditional: { etag: string | null; lastModified: string | null },
  fetcher: typeof fetch = fetch,
): Promise<FeedFetchResult> => {
  let current = assertSafeFeedUrl(input);
  let permanentOnly = true;
  let followedPermanentRedirect = false;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const headers = new Headers({
      Accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      "User-Agent": "rss-sync-worker/0.1",
    });
    if (conditional.etag !== null) headers.set("If-None-Match", conditional.etag);
    if (conditional.lastModified !== null)
      headers.set("If-Modified-Since", conditional.lastModified);

    const response = await fetchWithTimeout(fetcher, current, { headers, redirect: "manual" });
    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
      if (redirects === MAX_REDIRECTS) {
        throw new FeedFetchError("too_many_redirects", "feed exceeded redirect limit");
      }
      if (response.status === 301 || response.status === 308) {
        followedPermanentRedirect = true;
      } else {
        permanentOnly = false;
      }
      current = assertSafeFeedUrl(new URL(location, current));
      await response.body?.cancel();
      continue;
    }

    if (response.status === 304) {
      return {
        status: "not-modified",
        body: null,
        finalUrl: current.toString(),
        permanentRedirectTarget:
          followedPermanentRedirect && permanentOnly && current.toString() !== input
            ? current.toString()
            : null,
        etag: response.headers.get("etag") ?? conditional.etag,
        lastModified: response.headers.get("last-modified") ?? conditional.lastModified,
        contentType: response.headers.get("content-type"),
      };
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new FeedFetchError("http_error", `feed returned HTTP ${response.status}`);
    }

    return {
      status: "fetched",
      body: await readBodyLimited(response),
      finalUrl: current.toString(),
      permanentRedirectTarget:
        followedPermanentRedirect && permanentOnly && current.toString() !== input
          ? current.toString()
          : null,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentType: response.headers.get("content-type"),
    };
  }

  throw new FeedFetchError("too_many_redirects", "feed exceeded redirect limit");
};
