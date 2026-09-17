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

const upsertEntry = async (
  db: D1Database,
  feed: DispatchedFeed,
  parsed: ParsedEntry,
  bootstrapRead: boolean,
  now: number,
): Promise<boolean> => {
  const key = await identityKey(parsed, feed.canonicalFeedUrl);
  const url = canonicalizeEntryUrl(parsed.url, feed.canonicalFeedUrl);
  const bytes = new TextEncoder().encode(parsed.contentHtml).byteLength;
  const contentStatus =
    bytes === 0 ? "empty" : bytes > MAX_ENTRY_CONTENT_BYTES ? "oversized" : "stored";

  const inserted = await db
    .prepare(
      `INSERT INTO entries (
        feed_id, identity_key, source_id, title, url, author, published_at,
        source_updated_at, ingested_at, last_source_seen_at, content_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id, identity_key) DO NOTHING`,
    )
    .bind(
      feed.id,
      key,
      parsed.sourceId,
      parsed.title,
      url,
      parsed.author,
      parsed.publishedAt,
      parsed.sourceUpdatedAt,
      now,
      now,
      contentStatus,
      now,
      now,
    )
    .run();

  const row = await db
    .prepare("SELECT id FROM entries WHERE feed_id = ? AND identity_key = ?")
    .bind(feed.id, key)
    .first<{ id: number }>();
  if (row === null) throw new Error("entry upsert did not produce an entry");

  await db
    .prepare(
      `UPDATE entries
       SET source_id = COALESCE(?, source_id),
           title = CASE WHEN ? = '' THEN title ELSE ? END,
           url = COALESCE(?, url),
           author = COALESCE(?, author),
           published_at = COALESCE(?, published_at),
           source_updated_at = COALESCE(?, source_updated_at),
           last_source_seen_at = ?,
           content_status = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      parsed.sourceId,
      parsed.title,
      parsed.title,
      url,
      parsed.author,
      parsed.publishedAt,
      parsed.sourceUpdatedAt,
      now,
      contentStatus,
      now,
      row.id,
    )
    .run();

  if ((inserted.meta.changes ?? 0) === 1) {
    await db
      .prepare(
        `INSERT INTO entry_states (
          entry_id, is_read, is_starred, read_changed_at, starred_changed_at, updated_at
        ) VALUES (?, ?, 0, NULL, NULL, ?)`,
      )
      .bind(row.id, bootstrapRead ? 1 : 0, now)
      .run();
  }

  if (contentStatus === "stored") {
    const hash = await sha256Hex(parsed.contentHtml);
    await db
      .prepare(
        `INSERT INTO entry_contents (
          entry_id, content_html, content_hash, encoded_size_bytes, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET
          content_html = excluded.content_html,
          content_hash = excluded.content_hash,
          encoded_size_bytes = excluded.encoded_size_bytes,
          updated_at = excluded.updated_at`,
      )
      .bind(row.id, parsed.contentHtml, hash, bytes, now)
      .run();
  } else {
    await db.prepare("DELETE FROM entry_contents WHERE entry_id = ?").bind(row.id).run();
  }

  return (inserted.meta.changes ?? 0) === 1;
};

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

  let insertedEntries = 0;
  const bootstrapRead = feed.bootstrappedAt === null;
  const fetchedFeed = { ...feed, canonicalFeedUrl: responseMeta.finalUrl };
  for (const entry of parsed.entries) {
    if (await upsertEntry(db, fetchedFeed, entry, bootstrapRead, now)) insertedEntries += 1;
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

  return { insertedEntries, totalEntries: parsed.entries.length };
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
