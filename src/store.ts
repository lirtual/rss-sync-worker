import type { ParsedEntry, ParsedFeed } from "./feed/parser";

const MAX_ENTRY_CONTENT_BYTES = 512 * 1024;
const DISPATCH_DEADLINE_MS = 15 * 60 * 1000;
const CHANGED_REFRESH_MS = 30 * 60 * 1000;
const QUIET_REFRESH_MS = 60 * 60 * 1000;
const FAILURE_BASE_MS = 15 * 60 * 1000;
const FAILURE_MAX_MS = 24 * 60 * 60 * 1000;
const REDIRECT_CONFIRMATIONS = 3;

export interface SubscriptionView {
  feedId: number;
  feedUrl: string;
  siteUrl: string | null;
  title: string;
}

export interface DispatchedFeed {
  id: number;
  canonicalFeedUrl: string;
  etag: string | null;
  lastModified: string | null;
  bootstrappedAt: number | null;
  consecutiveFailures: number;
}

export interface RefreshResponseMeta {
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  permanentRedirectTarget: string | null;
}

export interface RefreshPersistResult {
  insertedEntries: number;
  totalEntries: number;
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizeText = (value: string): string => value.trim().replace(/\s+/gu, " ");

export const canonicalizeFeedUrl = (raw: string): string => {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("feed URL must use http or https");
  }
  url.hash = "";
  return url.toString();
};

const canonicalizeEntryUrl = (raw: string | null, feedUrl: string): string | null => {
  if (raw === null || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim(), feedUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

const normalizeContentUrls = (html: string, baseUrl: string): string =>
  html.replace(
    /(\s)(href|src|poster)\s*=\s*(["'])(.*?)\3/giu,
    (_match, whitespace: string, attribute: string, quote: string, rawValue: string) => {
      try {
        const url = new URL(rawValue.trim(), baseUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") return "";
        return `${whitespace}${attribute}=${quote}${url.toString()}${quote}`;
      } catch {
        return "";
      }
    },
  );

const identityKey = async (entry: ParsedEntry, feedUrl: string): Promise<string> => {
  const sourceId = entry.sourceId?.trim();
  if (sourceId) return sha256Hex(`guid:${sourceId}`);

  const url = canonicalizeEntryUrl(entry.url, feedUrl);
  if (url !== null) return sha256Hex(`url:${url}`);

  const fallback = [
    normalizeText(entry.title).toLocaleLowerCase(),
    entry.publishedAt === null ? "" : String(entry.publishedAt),
    normalizeText(entry.author ?? "").toLocaleLowerCase(),
  ].join("\u001f");
  return sha256Hex(`fallback:${fallback}`);
};

const findFeedByUrl = async (db: D1Database, feedUrl: string): Promise<{ id: number } | null> =>
  db
    .prepare(
      `SELECT id
       FROM feeds
       WHERE canonical_feed_url = ?
       UNION ALL
       SELECT feed_id AS id
       FROM feed_url_aliases
       WHERE url = ?
       LIMIT 1`,
    )
    .bind(feedUrl, feedUrl)
    .first<{ id: number }>();

export const ensureSubscription = async (
  db: D1Database,
  rawUrl: string,
  now: number,
): Promise<number> => {
  const feedUrl = canonicalizeFeedUrl(rawUrl);
  let row = await findFeedByUrl(db, feedUrl);

  if (row === null) {
    await db
      .prepare(
        `INSERT INTO feeds (
          canonical_feed_url, title, next_fetch_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(canonical_feed_url) DO NOTHING`,
      )
      .bind(feedUrl, feedUrl, now, now, now)
      .run();
    row = await findFeedByUrl(db, feedUrl);
  }

  if (row === null) throw new Error("failed to create feed");

  await db
    .prepare(
      `INSERT INTO subscriptions (feed_id, active, created_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(feed_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at`,
    )
    .bind(row.id, now, now)
    .run();

  return row.id;
};

export const listSubscriptions = async (db: D1Database): Promise<SubscriptionView[]> => {
  const result = await db
    .prepare(
      `SELECT f.id AS feedId,
              f.canonical_feed_url AS feedUrl,
              f.site_url AS siteUrl,
              COALESCE(s.custom_title, NULLIF(f.title, ''), f.canonical_feed_url) AS title
       FROM subscriptions s
       JOIN feeds f ON f.id = s.feed_id
       WHERE s.active = 1
       ORDER BY title COLLATE NOCASE, f.id`,
    )
    .all<SubscriptionView>();
  return result.results;
};

export const claimDispatch = async (
  db: D1Database,
  feedId: number,
  now: number,
): Promise<RefreshMessage | null> => {
  const token = crypto.randomUUID();
  const result = await db
    .prepare(
      `UPDATE feeds
       SET dispatch_token = ?, dispatch_deadline_at = ?, updated_at = ?
       WHERE id = ?
         AND (dispatch_deadline_at IS NULL OR dispatch_deadline_at <= ?)`,
    )
    .bind(token, now + DISPATCH_DEADLINE_MS, now, feedId, now)
    .run();

  if ((result.meta.changes ?? 0) !== 1) return null;
  return { feedId, dispatchToken: token, dispatchedAt: now };
};

export const listDueFeedIds = async (
  db: D1Database,
  now: number,
  limit: number,
): Promise<number[]> => {
  const result = await db
    .prepare(
      `SELECT f.id
       FROM feeds f
       JOIN subscriptions s ON s.feed_id = f.id AND s.active = 1
       WHERE f.next_fetch_at <= ?
         AND (f.dispatch_deadline_at IS NULL OR f.dispatch_deadline_at <= ?)
       ORDER BY f.next_fetch_at, f.id
       LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ id: number }>();
  return result.results.map((row) => row.id);
};

export const loadDispatchedFeed = async (
  db: D1Database,
  message: RefreshMessage,
): Promise<DispatchedFeed | null> =>
  db
    .prepare(
      `SELECT f.id,
              f.canonical_feed_url AS canonicalFeedUrl,
              f.etag,
              f.last_modified AS lastModified,
              f.consecutive_failures AS consecutiveFailures,
              s.bootstrapped_at AS bootstrappedAt
       FROM feeds f
       JOIN subscriptions s ON s.feed_id = f.id AND s.active = 1
       WHERE f.id = ? AND f.dispatch_token = ?`,
    )
    .bind(message.feedId, message.dispatchToken)
    .first<DispatchedFeed>();

const recordRedirectEvidence = async (
  db: D1Database,
  feed: DispatchedFeed,
  message: RefreshMessage,
  target: string | null,
  now: number,
): Promise<void> => {
  if (target === null || target === feed.canonicalFeedUrl) {
    await db
      .prepare(
        `UPDATE feeds
         SET redirect_candidate_url = NULL, redirect_candidate_successes = 0
         WHERE id = ? AND dispatch_token = ?`,
      )
      .bind(feed.id, message.dispatchToken)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE feeds
       SET redirect_candidate_successes = CASE
             WHEN redirect_candidate_url = ? THEN redirect_candidate_successes + 1
             ELSE 1
           END,
           redirect_candidate_url = ?,
           updated_at = ?
       WHERE id = ? AND dispatch_token = ?`,
    )
    .bind(target, target, now, feed.id, message.dispatchToken)
    .run();

  const candidate = await db
    .prepare(
      `SELECT redirect_candidate_url AS url, redirect_candidate_successes AS successes
       FROM feeds
       WHERE id = ? AND dispatch_token = ?`,
    )
    .bind(feed.id, message.dispatchToken)
    .first<{ url: string | null; successes: number }>();
  if (candidate?.url !== target || candidate.successes < REDIRECT_CONFIRMATIONS) return;

  const conflict = await db
    .prepare(
      `SELECT 1 AS conflict
       FROM feeds
       WHERE canonical_feed_url = ? AND id <> ?
       UNION ALL
       SELECT 1 AS conflict
       FROM feed_url_aliases
       WHERE url = ? AND feed_id <> ?
       LIMIT 1`,
    )
    .bind(target, feed.id, target, feed.id)
    .first<{ conflict: number }>();
  if (conflict !== null) return;

  await db.batch([
    db
      .prepare(
        `INSERT INTO feed_url_aliases (url, feed_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(url) DO NOTHING`,
      )
      .bind(feed.canonicalFeedUrl, feed.id, now),
    db
      .prepare(
        `UPDATE feeds
         SET canonical_feed_url = ?, redirect_candidate_url = NULL,
             redirect_candidate_successes = 0, updated_at = ?
         WHERE id = ? AND dispatch_token = ? AND redirect_candidate_url = ?`,
      )
      .bind(target, now, feed.id, message.dispatchToken, target),
  ]);
};

export const persistNotModifiedRefresh = async (
  db: D1Database,
  feed: DispatchedFeed,
  message: RefreshMessage,
  responseMeta: RefreshResponseMeta,
  now: number,
): Promise<void> => {
  await recordRedirectEvidence(db, feed, message, responseMeta.permanentRedirectTarget, now);
  await db
    .prepare(
      `UPDATE feeds
       SET etag = ?, last_modified = ?, last_attempt_at = ?, last_success_at = ?,
           next_fetch_at = ?, consecutive_failures = 0,
           last_error_class = NULL, last_error_message = NULL,
           dispatch_token = NULL, dispatch_deadline_at = NULL, updated_at = ?
       WHERE id = ? AND dispatch_token = ?`,
    )
    .bind(
      responseMeta.etag,
      responseMeta.lastModified,
      now,
      now,
      now + QUIET_REFRESH_MS,
      now,
      feed.id,
      message.dispatchToken,
    )
    .run();
};

export const persistSuccessfulRefresh = async (
  db: D1Database,
  feed: DispatchedFeed,
  message: RefreshMessage,
  parsed: ParsedFeed,
  responseMeta: RefreshResponseMeta,
  now: number,
): Promise<RefreshPersistResult> => {
  await recordRedirectEvidence(db, feed, message, responseMeta.permanentRedirectTarget, now);

  const bootstrapRead = feed.bootstrappedAt === null;
  const fetchedFeed = { ...feed, canonicalFeedUrl: responseMeta.finalUrl };
  const preparedByKey = new Map<
    string,
    {
      identityKey: string;
      sourceId: string | null;
      title: string;
      url: string | null;
      author: string | null;
      publishedAt: number | null;
      sourceUpdatedAt: number | null;
      contentStatus: "empty" | "oversized" | "stored";
      contentHtml: string | null;
      contentHash: string | null;
      bytes: number;
      enclosures: Array<{
        url: string;
        mimeType: string | null;
        lengthBytes: number | null;
        title: string | null;
      }>;
    }
  >();

  for (const entry of parsed.entries) {
    const key = await identityKey(entry, fetchedFeed.canonicalFeedUrl);
    const url = canonicalizeEntryUrl(entry.url, fetchedFeed.canonicalFeedUrl);
    const enclosures = entry.enclosures.flatMap((enclosure) => {
      const enclosureUrl = canonicalizeEntryUrl(enclosure.url, url ?? fetchedFeed.canonicalFeedUrl);
      return enclosureUrl === null
        ? []
        : [
            {
              url: enclosureUrl,
              mimeType: enclosure.mimeType,
              lengthBytes: enclosure.lengthBytes,
              title: enclosure.title,
            },
          ];
    });
    const contentBaseUrl = url ?? fetchedFeed.canonicalFeedUrl;
    const normalizedContentHtml = normalizeContentUrls(entry.contentHtml, contentBaseUrl);
    const bytes = new TextEncoder().encode(normalizedContentHtml).byteLength;
    const contentStatus =
      bytes === 0 ? "empty" : bytes > MAX_ENTRY_CONTENT_BYTES ? "oversized" : "stored";
    preparedByKey.set(key, {
      identityKey: key,
      sourceId: entry.sourceId,
      title: entry.title,
      url,
      author: entry.author,
      publishedAt: entry.publishedAt,
      sourceUpdatedAt: entry.sourceUpdatedAt,
      contentStatus,
      contentHtml: contentStatus === "stored" ? normalizedContentHtml : null,
      contentHash: contentStatus === "stored" ? await sha256Hex(normalizedContentHtml) : null,
      bytes,
      enclosures,
    });
  }

  const prepared = [...preparedByKey.values()];
  const encoder = new TextEncoder();
  const jsonChunks = (records: unknown[], maxBytes = 1_500_000): string[] => {
    const chunks: string[] = [];
    let current: unknown[] = [];
    let currentBytes = 2;
    for (const record of records) {
      const serialized = JSON.stringify(record);
      const recordBytes = encoder.encode(serialized).byteLength + (current.length === 0 ? 0 : 1);
      if (recordBytes + 2 > maxBytes) {
        throw new Error("bulk D1 record exceeds safe JSON parameter size");
      }
      if (current.length > 0 && currentBytes + recordBytes > maxBytes) {
        chunks.push(JSON.stringify(current));
        current = [];
        currentBytes = 2;
      }
      current.push(record);
      currentBytes += recordBytes;
    }
    if (current.length > 0) chunks.push(JSON.stringify(current));
    return chunks;
  };

  const metadataRecords = prepared.map(
    ({
      contentHtml: _contentHtml,
      contentHash: _contentHash,
      bytes: _bytes,
      enclosures: _enclosures,
      ...metadata
    }) => metadata,
  );
  const entrySql = `INSERT INTO entries (
      feed_id, identity_key, source_id, title, url, author, published_at,
      source_updated_at, ingested_at, last_source_seen_at, content_status,
      created_at, updated_at
    )
    SELECT ?,
           json_extract(j.value, '$.identityKey'),
           json_extract(j.value, '$.sourceId'),
           COALESCE(json_extract(j.value, '$.title'), ''),
           json_extract(j.value, '$.url'),
           json_extract(j.value, '$.author'),
           json_extract(j.value, '$.publishedAt'),
           json_extract(j.value, '$.sourceUpdatedAt'),
           ?, ?, json_extract(j.value, '$.contentStatus'), ?, ?
    FROM json_each(?) AS j
    WHERE 1
    ON CONFLICT(feed_id, identity_key) DO UPDATE SET
      source_id = COALESCE(excluded.source_id, entries.source_id),
      title = CASE WHEN excluded.title = '' THEN entries.title ELSE excluded.title END,
      url = COALESCE(excluded.url, entries.url),
      author = COALESCE(excluded.author, entries.author),
      published_at = COALESCE(excluded.published_at, entries.published_at),
      source_updated_at = COALESCE(excluded.source_updated_at, entries.source_updated_at),
      last_source_seen_at = excluded.last_source_seen_at,
      content_status = excluded.content_status,
      updated_at = excluded.updated_at
    WHERE COALESCE(excluded.source_id, entries.source_id) IS NOT entries.source_id
       OR (CASE WHEN excluded.title = '' THEN entries.title ELSE excluded.title END) IS NOT entries.title
       OR COALESCE(excluded.url, entries.url) IS NOT entries.url
       OR COALESCE(excluded.author, entries.author) IS NOT entries.author
       OR COALESCE(excluded.published_at, entries.published_at) IS NOT entries.published_at
       OR COALESCE(excluded.source_updated_at, entries.source_updated_at) IS NOT entries.source_updated_at
       OR excluded.content_status IS NOT entries.content_status`;
  const stateSql = `INSERT OR IGNORE INTO entry_states (
      entry_id, is_read, is_starred, read_changed_at, starred_changed_at, updated_at
    )
    SELECT e.id, ?, 0, NULL, NULL, ?
    FROM json_each(?) AS j
    JOIN entries e
      ON e.feed_id = ?
     AND e.identity_key = json_extract(j.value, '$.identityKey')`;

  for (const chunk of jsonChunks(metadataRecords)) {
    await db.prepare(entrySql).bind(feed.id, now, now, now, now, chunk).run();
    await db
      .prepare(stateSql)
      .bind(bootstrapRead ? 1 : 0, now, chunk, feed.id)
      .run();
  }

  const observedIdentityRecords = prepared.map((record) => ({
    identityKey: record.identityKey,
  }));
  for (const chunk of jsonChunks(observedIdentityRecords)) {
    await db
      .prepare(
        `DELETE FROM entry_enclosures
         WHERE entry_id IN (
           SELECT e.id
           FROM json_each(?) AS j
           JOIN entries e
             ON e.feed_id = ?
            AND e.identity_key = json_extract(j.value, '$.identityKey')
         )`,
      )
      .bind(chunk, feed.id)
      .run();
  }

  const enclosureRecords = prepared.flatMap((record) =>
    record.enclosures.map((enclosure, position) => ({
      identityKey: record.identityKey,
      position,
      ...enclosure,
    })),
  );
  const enclosureSql = `INSERT INTO entry_enclosures (
      entry_id, position, url, mime_type, length_bytes, title
    )
    SELECT e.id,
           json_extract(j.value, '$.position'),
           json_extract(j.value, '$.url'),
           json_extract(j.value, '$.mimeType'),
           json_extract(j.value, '$.lengthBytes'),
           json_extract(j.value, '$.title')
    FROM json_each(?) AS j
    JOIN entries e
      ON e.feed_id = ?
     AND e.identity_key = json_extract(j.value, '$.identityKey')`;
  for (const chunk of jsonChunks(enclosureRecords)) {
    await db.prepare(enclosureSql).bind(chunk, feed.id).run();
  }

  const identityPayload = JSON.stringify(
    prepared.map((record) => ({ identityKey: record.identityKey })),
  );
  const inserted =
    prepared.length === 0
      ? { count: 0 }
      : await db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM entries e
             JOIN json_each(?) AS j
               ON e.feed_id = ?
              AND e.identity_key = json_extract(j.value, '$.identityKey')
             WHERE e.created_at = ?`,
          )
          .bind(identityPayload, feed.id, now)
          .first<{ count: number }>();
  const insertedEntries = Number(inserted?.count ?? 0);

  const storedRecords = prepared
    .filter((record) => record.contentStatus === "stored")
    .map((record) => ({
      identityKey: record.identityKey,
      contentHtml: record.contentHtml,
      contentHash: record.contentHash,
      bytes: record.bytes,
    }));
  const contentSql = `INSERT INTO entry_contents (
      entry_id, content_html, content_hash, encoded_size_bytes, updated_at
    )
    SELECT e.id,
           json_extract(j.value, '$.contentHtml'),
           json_extract(j.value, '$.contentHash'),
           json_extract(j.value, '$.bytes'),
           ?
    FROM json_each(?) AS j
    JOIN entries e
      ON e.feed_id = ?
     AND e.identity_key = json_extract(j.value, '$.identityKey')
    WHERE 1
    ON CONFLICT(entry_id) DO UPDATE SET
      content_html = excluded.content_html,
      content_hash = excluded.content_hash,
      encoded_size_bytes = excluded.encoded_size_bytes,
      updated_at = excluded.updated_at
    WHERE entry_contents.content_hash IS NOT excluded.content_hash
       OR entry_contents.encoded_size_bytes IS NOT excluded.encoded_size_bytes`;
  for (const chunk of jsonChunks(storedRecords)) {
    await db.prepare(contentSql).bind(now, chunk, feed.id).run();
  }

  const withoutContent = prepared
    .filter((record) => record.contentStatus !== "stored")
    .map((record) => ({ identityKey: record.identityKey }));
  for (const chunk of jsonChunks(withoutContent)) {
    await db
      .prepare(
        `DELETE FROM entry_contents
         WHERE entry_id IN (
           SELECT e.id
           FROM json_each(?) AS j
           JOIN entries e
             ON e.feed_id = ?
            AND e.identity_key = json_extract(j.value, '$.identityKey')
         )`,
      )
      .bind(chunk, feed.id)
      .run();
  }

  if (feed.bootstrappedAt === null) {
    await db
      .prepare(
        `UPDATE subscriptions
         SET bootstrapped_at = COALESCE(bootstrapped_at, ?), updated_at = ?
         WHERE feed_id = ? AND active = 1`,
      )
      .bind(now, now, feed.id)
      .run();
  }

  await db
    .prepare(
      `UPDATE feeds
       SET title = ?, site_url = ?, etag = ?, last_modified = ?,
           last_attempt_at = ?, last_success_at = ?,
           next_fetch_at = ?, consecutive_failures = 0,
           last_error_class = NULL, last_error_message = NULL,
           last_change_at = CASE WHEN ? > 0 THEN ? ELSE last_change_at END,
           dispatch_token = NULL, dispatch_deadline_at = NULL,
           updated_at = ?
       WHERE id = ? AND dispatch_token = ?`,
    )
    .bind(
      parsed.title,
      parsed.siteUrl,
      responseMeta.etag,
      responseMeta.lastModified,
      now,
      now,
      now + (insertedEntries > 0 ? CHANGED_REFRESH_MS : QUIET_REFRESH_MS),
      insertedEntries,
      now,
      now,
      feed.id,
      message.dispatchToken,
    )
    .run();

  return { insertedEntries, totalEntries: prepared.length };
};

export const recordRefreshFailure = async (
  db: D1Database,
  feed: DispatchedFeed,
  message: RefreshMessage,
  now: number,
  error: unknown,
): Promise<void> => {
  const summary = error instanceof Error ? error.message.slice(0, 1024) : "unknown refresh failure";
  const errorClass = error instanceof Error ? error.name.slice(0, 128) : "refresh";
  const multiplier = 2 ** Math.min(feed.consecutiveFailures, 7);
  const delay = Math.min(FAILURE_BASE_MS * multiplier, FAILURE_MAX_MS);
  await db
    .prepare(
      `UPDATE feeds
       SET last_attempt_at = ?,
           consecutive_failures = consecutive_failures + 1,
           last_error_class = ?,
           last_error_message = ?,
           next_fetch_at = ?,
           dispatch_token = NULL,
           dispatch_deadline_at = NULL,
           updated_at = ?
       WHERE id = ? AND dispatch_token = ?`,
    )
    .bind(now, errorClass, summary, now + delay, now, feed.id, message.dispatchToken)
    .run();
};
