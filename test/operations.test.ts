import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  cleanupRetainedEntries,
  RETENTION_AGE_MS,
  RETENTION_BATCH_LIMIT,
} from "../src/ops-store";
import { dispatchDueFeeds, enqueueFeedRefresh } from "../src/refresh";
import { ensureSubscription } from "../src/store";

const adminHeaders = { Authorization: "Bearer test-admin-token" };
const dayKey = (value: number): string => new Date(value).toISOString().slice(0, 10);

const insertEntry = async (
  feedId: number,
  identityKey: string,
  sourceId: string,
  ingestedAt: number,
  isRead: number,
  isStarred: number,
): Promise<void> => {
  const result = await env.DB.prepare(
    `INSERT INTO entries (
       feed_id, identity_key, source_id, title, url, author, published_at,
       source_updated_at, ingested_at, last_source_seen_at, content_status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'empty', ?, ?)` ,
  )
    .bind(feedId, identityKey, sourceId, sourceId, ingestedAt, ingestedAt, ingestedAt, ingestedAt)
    .run();
  const entryId = Number(result.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO entry_states (entry_id, is_read, is_starred, updated_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(entryId, isRead, isStarred, ingestedAt)
    .run();
};

describe("free-plan operations", () => {
  it("deletes retention-eligible entries only in bounded batches", async () => {
    const now = Date.now();
    const old = now - RETENTION_AGE_MS - 1_000;
    const feedId = await ensureSubscription(env.DB, "https://retention.example/feed.xml", now);

    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (
         VALUES(1)
         UNION ALL
         SELECT n + 1 FROM seq WHERE n < 505
       )
       INSERT INTO entries (
         feed_id, identity_key, source_id, title, url, author, published_at,
         source_updated_at, ingested_at, last_source_seen_at, content_status,
         created_at, updated_at
       )
       SELECT ?, printf('%064x', n), 'eligible-' || n, 'eligible-' || n,
              NULL, NULL, NULL, NULL, ?, ?, 'empty', ?, ?
       FROM seq`,
    )
      .bind(feedId, old, old, old, old)
      .run();
    await env.DB.prepare(
      `INSERT INTO entry_states (entry_id, is_read, is_starred, updated_at)
       SELECT id, 1, 0, ? FROM entries WHERE feed_id = ?`,
    )
      .bind(old, feedId)
      .run();

    await insertEntry(feedId, "u".repeat(64), "old-unread", old, 0, 0);
    await insertEntry(feedId, "s".repeat(64), "old-starred", old, 1, 1);
    await insertEntry(feedId, "r".repeat(64), "recent-read", now - 60_000, 1, 0);

    expect(await cleanupRetainedEntries(env.DB, now)).toBe(RETENTION_BATCH_LIMIT);

    const firstPass = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN source_id LIKE 'eligible-%' THEN 1 ELSE 0 END) AS eligible,
         SUM(CASE WHEN source_id = 'old-unread' THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN source_id = 'old-starred' THEN 1 ELSE 0 END) AS starred,
         SUM(CASE WHEN source_id = 'recent-read' THEN 1 ELSE 0 END) AS recent
       FROM entries WHERE feed_id = ?`,
    )
      .bind(feedId)
      .first<{ eligible: number; unread: number; starred: number; recent: number }>();
    expect(firstPass).toEqual({ eligible: 5, unread: 1, starred: 1, recent: 1 });

    expect(await cleanupRetainedEntries(env.DB, now)).toBe(5);
    const protectedRows = await env.DB.prepare(
      `SELECT source_id AS sourceId FROM entries WHERE feed_id = ? ORDER BY source_id`,
    )
      .bind(feedId)
      .all<{ sourceId: string }>();
    expect(protectedRows.results.map((row) => row.sourceId)).toEqual([
      "old-starred",
      "old-unread",
      "recent-read",
    ]);
  });

  it("stops Cron dispatch at the daily budget and resets on the next UTC day", async () => {
    const now = Date.now();
    const first = await ensureSubscription(env.DB, "https://budget-a.example/feed.xml", now);
    const second = await ensureSubscription(env.DB, "https://budget-b.example/feed.xml", now);
    await env.DB.prepare(
      `UPDATE service_state
       SET budget_day = ?, dispatches_today = 1599, updated_at = ?
       WHERE id = 1`,
    )
      .bind(dayKey(now), now)
      .run();

    const summary = await dispatchDueFeeds(env, now, 20);
    expect(summary.dispatched).toBe(1);
    expect(summary.budgetExhausted).toBe(true);

    const rows = await env.DB.prepare(
      `SELECT id, dispatch_token AS token FROM feeds WHERE id IN (?, ?) ORDER BY id`,
    )
      .bind(first, second)
      .all<{ id: number; token: string | null }>();
    expect(rows.results.filter((row) => row.token !== null)).toHaveLength(1);

    const nextDay = now + 24 * 60 * 60 * 1_000;
    const undispatched = rows.results.find((row) => row.token === null);
    if (undispatched === undefined) throw new Error("expected one deferred feed");
    expect(await enqueueFeedRefresh(env, undispatched.id, nextDay)).toBe("enqueued");

    const state = await env.DB.prepare(
      "SELECT budget_day AS day, dispatches_today AS used FROM service_state WHERE id = 1",
    ).first<{ day: string; used: number }>();
    expect(state).toEqual({ day: dayKey(nextDay), used: 1 });
  });

  it("exposes diagnostics and routes manual refresh through the Queue path", async () => {
    const now = Date.now();
    const feedId = await ensureSubscription(env.DB, "https://admin-ops.example/feed.xml", now);

    const feedsResponse = await exports.default.fetch(
      new Request("https://rss-sync.test/admin/feeds?limit=1", { headers: adminHeaders }),
    );
    expect(feedsResponse.status).toBe(200);
    const feeds = (await feedsResponse.json()) as {
      feeds: Array<{ id: number; url: string }>;
      nextCursor: number | null;
    };
    expect(feeds.feeds).toHaveLength(1);
    expect(feeds.feeds[0]?.url).toBe("https://admin-ops.example/feed.xml");

    const refresh = await exports.default.fetch(
      new Request(`https://rss-sync.test/admin/feeds/${feedId}/refresh`, {
        method: "POST",
        headers: adminHeaders,
      }),
    );
    expect(refresh.status).toBe(202);
    expect(await refresh.json()).toEqual({ status: "enqueued" });

    const duplicate = await exports.default.fetch(
      new Request(`https://rss-sync.test/admin/feeds/${feedId}/refresh`, {
        method: "POST",
        headers: adminHeaders,
      }),
    );
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ status: "already-dispatched" });

    const statusResponse = await exports.default.fetch(
      new Request("https://rss-sync.test/admin/status", { headers: adminHeaders }),
    );
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as {
      status: string;
      feeds: number;
      activeSubscriptions: number;
      dispatchBudget: { used: number; limit: number; throttled: boolean };
    };
    expect(status.status).toBe("ok");
    expect(status.feeds).toBeGreaterThanOrEqual(1);
    expect(status.activeSubscriptions).toBeGreaterThanOrEqual(1);
    expect(status.dispatchBudget.limit).toBe(1600);
    expect(status.dispatchBudget.used).toBe(1);
    expect(status.dispatchBudget.throttled).toBe(false);
  });
});
