import { fetchFeedDocument } from "./fetch";
import type { ParsedFeed } from "./parser";

const ICON_MAX_BYTES = 256 * 1024;
const HTML_MAX_BYTES = 1024 * 1024;
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 24 * 60 * 60 * 1000;

interface IconCacheRow {
  externalId: string;
  status: "found" | "missing";
  sourceUrl: string | null;
  mediaType: string | null;
  body: ArrayBuffer | null;
  etag: string | null;
  expiresAt: number;
}

export interface StoredFeedIcon {
  externalId: string;
  mediaType: string;
  body: ArrayBuffer;
  etag: string;
}

const mediaType = (value: string | null): string | null => {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") ? normalized : null;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const resolvePublicUrl = (raw: string, base: string): string | null => {
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const attributes = (tag: string): Map<string, string> => {
  const result = new Map<string, string>();
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/gu;
  for (const match of tag.matchAll(pattern)) {
    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key !== "") result.set(key, value);
  }
  return result;
};

const htmlIconCandidates = (html: string, baseUrl: string): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    if (
      !rel.includes("icon") &&
      !rel.includes("shortcut") &&
      !rel.includes("apple-touch-icon")
    ) {
      continue;
    }
    const href = attrs.get("href") ?? "";
    const resolved = resolvePublicUrl(href, baseUrl);
    if (resolved !== null && !seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
};

const loadCache = async (db: D1Database, feedId: number): Promise<IconCacheRow | null> =>
  db
    .prepare(
      `SELECT external_id AS externalId,
              status,
              source_url AS sourceUrl,
              media_type AS mediaType,
              body,
              etag,
              expires_at AS expiresAt
       FROM feed_icons
       WHERE feed_id = ?`,
    )
    .bind(feedId)
    .first<IconCacheRow>();

const fetchIcon = async (
  url: string,
  fetcher: typeof fetch,
): Promise<{ sourceUrl: string; mediaType: string; body: Uint8Array; etag: string } | null> => {
  try {
    const fetched = await fetchFeedDocument(url, { etag: null, lastModified: null }, fetcher, {
      maxBodyBytes: ICON_MAX_BYTES,
      accept: "image/*,*/*;q=0.1",
    });
    if (fetched.status !== "fetched" || fetched.body === null || fetched.body.byteLength === 0) {
      return null;
    }
    const type = mediaType(fetched.contentType);
    if (type === null) return null;
    const hash = await sha256Hex(fetched.body);
    return {
      sourceUrl: fetched.finalUrl,
      mediaType: type,
      body: fetched.body,
      etag: `"${hash}"`,
    };
  } catch {
    return null;
  }
};

const htmlCandidates = async (
  siteUrl: string,
  fetcher: typeof fetch,
): Promise<string[]> => {
  try {
    const fetched = await fetchFeedDocument(
      siteUrl,
      { etag: null, lastModified: null },
      fetcher,
      {
        maxBodyBytes: HTML_MAX_BYTES,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    );
    if (fetched.status !== "fetched" || fetched.body === null) return [];
    const type = fetched.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (type !== "" && type !== "text/html" && type !== "application/xhtml+xml") return [];
    const html = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(fetched.body);
    return htmlIconCandidates(html, fetched.finalUrl);
  } catch {
    return [];
  }
};

const persistMissing = async (
  db: D1Database,
  feedId: number,
  externalId: string,
  now: number,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO feed_icons (
         feed_id, external_id, status, source_url, media_type, body, etag, checked_at, expires_at
       ) VALUES (?, ?, 'missing', NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(feed_id) DO UPDATE SET
         status = 'missing',
         source_url = NULL,
         media_type = NULL,
         body = NULL,
         etag = NULL,
         checked_at = excluded.checked_at,
         expires_at = excluded.expires_at`,
    )
    .bind(feedId, externalId, now, now + MISSING_TTL_MS)
    .run();
};

export const refreshFeedIcon = async (
  db: D1Database,
  feedId: number,
  parsed: ParsedFeed,
  finalFeedUrl: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const existing = await loadCache(db, feedId);
  if (existing !== null && existing.expiresAt > now) return;

  const externalId = existing?.externalId ?? crypto.randomUUID();
  const siteUrl = parsed.siteUrl === null ? null : resolvePublicUrl(parsed.siteUrl, finalFeedUrl);
  const seen = new Set<string>();

  const storeFirstFound = async (rawCandidates: Array<string | null>): Promise<boolean> => {
    for (const candidate of rawCandidates) {
      if (candidate === null || seen.has(candidate)) continue;
      seen.add(candidate);
      const icon = await fetchIcon(candidate, fetcher);
      if (icon === null) continue;
      await db
        .prepare(
          `INSERT INTO feed_icons (
             feed_id, external_id, status, source_url, media_type, body, etag, checked_at, expires_at
           ) VALUES (?, ?, 'found', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(feed_id) DO UPDATE SET
             status = 'found',
             source_url = excluded.source_url,
             media_type = excluded.media_type,
             body = excluded.body,
             etag = excluded.etag,
             checked_at = excluded.checked_at,
             expires_at = excluded.expires_at`,
        )
        .bind(
          feedId,
          externalId,
          icon.sourceUrl,
          icon.mediaType,
          icon.body,
          icon.etag,
          now,
          now + FOUND_TTL_MS,
        )
        .run();
      return true;
    }
    return false;
  };

  const declared = parsed.iconUrls.map((raw) =>
    resolvePublicUrl(raw, siteUrl ?? finalFeedUrl),
  );
  if (await storeFirstFound(declared)) return;

  if (siteUrl !== null) {
    const discovered = await htmlCandidates(siteUrl, fetcher);
    if (await storeFirstFound(discovered)) return;
  }

  let fallback: string | null = null;
  try {
    fallback = new URL("/favicon.ico", siteUrl ?? finalFeedUrl).toString();
  } catch {
    fallback = null;
  }
  if (await storeFirstFound([fallback])) return;

  await persistMissing(db, feedId, externalId, now);
};

export const readFeedIcon = async (
  db: D1Database,
  externalId: string,
): Promise<StoredFeedIcon | null> => {
  const row = await db
    .prepare(
      `SELECT external_id AS externalId, media_type AS mediaType, body, etag
       FROM feed_icons
       WHERE external_id = ? AND status = 'found'`,
    )
    .bind(externalId)
    .first<{
      externalId: string;
      mediaType: string | null;
      body: ArrayBuffer | null;
      etag: string | null;
    }>();
  if (row === null || row.mediaType === null || row.body === null || row.etag === null) return null;
  return {
    externalId: row.externalId,
    mediaType: row.mediaType,
    body: row.body,
    etag: row.etag,
  };
};
