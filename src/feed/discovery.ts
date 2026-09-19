import { decodeFeedDocument } from "./decode";
import { FeedFetchError, fetchFeedDocument } from "./fetch";
import { parseFeed } from "./parser";

const HTML_DISCOVERY_MAX_BYTES = 1024 * 1024;
const DISCOVERY_ACCEPT =
  "application/atom+xml, application/rss+xml, application/feed+json, application/json, text/html, application/xhtml+xml, application/xml, text/xml;q=0.9, */*;q=0.1";
const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
]);

export interface DiscoveredFeed {
  feedUrl: string;
  title: string;
}

const parseFetchedFeed = (
  body: Uint8Array,
  contentType: string | null,
): { title: string } | null => {
  try {
    const decoded = decodeFeedDocument(body, contentType);
    return { title: parseFeed(decoded.text).title };
  } catch {
    return null;
  }
};

const isHtmlDocument = (body: Uint8Array, contentType: string | null): boolean => {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return true;
  const sample = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
    .decode(body.subarray(0, Math.min(body.byteLength, 512)))
    .trimStart()
    .toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html");
};

const attributes = (tag: string): Map<string, string> => {
  const result = new Map<string, string>();
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/gu;
  for (const match of tag.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name !== "") result.set(name, value);
  }
  return result;
};

const discoveryCandidates = (html: string, baseUrl: string): string[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const rel = (attrs.get("rel") ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    const type = (attrs.get("type") ?? "").toLowerCase().split(";", 1)[0]?.trim() ?? "";
    const href = attrs.get("href")?.trim() ?? "";
    if (!rel.includes("alternate") || !FEED_TYPES.has(type) || href === "") continue;
    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      candidates.push(resolved);
    }
  }
  return candidates;
};

export const discoverFeed = async (
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> => {
  const initial = await fetchFeedDocument(
    input,
    { etag: null, lastModified: null },
    fetcher,
    { accept: DISCOVERY_ACCEPT },
  );
  if (initial.status !== "fetched" || initial.body === null) return null;

  const direct = parseFetchedFeed(initial.body, initial.contentType);
  if (direct !== null) return { feedUrl: initial.finalUrl, title: direct.title };

  if (!isHtmlDocument(initial.body, initial.contentType)) return null;
  if (initial.body.byteLength > HTML_DISCOVERY_MAX_BYTES) {
    throw new FeedFetchError("response_too_large", "discovery HTML exceeds 1 MiB limit");
  }

  const html = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(initial.body);
  for (const candidate of discoveryCandidates(html, initial.finalUrl)) {
    try {
      const fetched = await fetchFeedDocument(
        candidate,
        { etag: null, lastModified: null },
        fetcher,
      );
      if (fetched.status !== "fetched" || fetched.body === null) continue;
      const parsed = parseFetchedFeed(fetched.body, fetched.contentType);
      if (parsed !== null) return { feedUrl: fetched.finalUrl, title: parsed.title };
    } catch (error) {
      if (error instanceof FeedFetchError && error.code === "unsafe_target") throw error;
    }
  }

  return null;
};
