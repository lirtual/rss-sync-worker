import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addFolderMembership } from "../src/folder-store";
import { ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const authHeaders = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const seedEntries = async (
  key: string,
  count: number,
  firstIngestedAt: number,
): Promise<number> => {
  const now = firstIngestedAt - 1_000;
  const feedId = await ensureSubscription(env.DB, `https://${key}.example/feed.xml`, now);
  await env.DB.prepare(
    "UPDATE subscriptions SET bootstrapped_at = ?, updated_at = ? WHERE feed_id = ?",
  )
    .bind(now, now, feedId)
    .run();

  await env.DB.prepare(
    `WITH RECURSIVE seq(n) AS (
       VALUES(1)
       UNION ALL
       SELECT n + 1 FROM seq WHERE n < ?
     )
     INSERT INTO entries (
       feed_id, identity_key, source_id, title, url, author, published_at,
       source_updated_at, ingested_at, last_source_seen_at, content_status,
       created_at, updated_at
     )
     SELECT ?, printf('%064x', n), ? || n, ? || n,
            ? || n, NULL, ?, NULL,
            ? + n, ? + n, 'empty', ? + n, ? + n
     FROM seq`,
  )
    .bind(
      count,
      feedId,
      `${key}-source-`,
      `${key}-title-`,
      `https://${key}.example/article/`,
      firstIngestedAt - 1_000_000,
      firstIngestedAt,
      firstIngestedAt,
      firstIngestedAt,
      firstIngestedAt,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO entry_states (entry_id, is_read, is_starred, updated_at)
     SELECT e.id, 0, 0, e.ingested_at
     FROM entries e
     LEFT JOIN entry_states es ON es.entry_id = e.id
     WHERE e.feed_id = ? AND es.entry_id IS NULL`,
  )
    .bind(feedId)
    .run();
  return feedId;
};

const markAll = async (stream: string, cutoffMs?: number): Promise<Response> => {
  const form = new URLSearchParams({ s: stream });
  if (cutoffMs !== undefined) form.set("ts", String(cutoffMs * 1_000));
  return exports.default.fetch(
    new Request(`${root}/mark-all-as-read`, {
      method: "POST",
      headers: authHeaders,
      body: form,
    }),
  );
};

const unread = async (
  where = "1 = 1",
  bindings: Array<string | number> = [],
): Promise<number> => {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM entries e
     JOIN entry_states es ON es.entry_id = e.id
     WHERE es.is_read = 0 AND ${where}`,
  )
    .bind(...bindings)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

describe("mark-all-as-read", () => {
  it("clears a 500-item reading-list backlog independent of client pagination", async () => {
    const base = Date.now() - 200_000;
    const cutoff = base + 1_000;
    const feedId = await seedEntries("bulk-global", 500, base);

    await env.DB.prepare(
      `INSERT INTO entries (
         feed_id, identity_key, source_id, title, url, author, published_at,
         source_updated_at, ingested_at, last_source_seen_at, content_status,
         created_at, updated_at
       ) VALUES (?, ?, 'late', 'Late', 'https://bulk-global.example/article/late',
                 NULL, ?, NULL, ?, ?, 'empty', ?, ?)` ,
    )
      .bind(
        feedId,
        "f".repeat(64),
        base - 10_000_000,
        cutoff + 1,
        cutoff + 1,
        cutoff + 1,
        cutoff + 1,
      )
      .run();
    const late = await env.DB.prepare(
      "SELECT id FROM entries WHERE feed_id = ? AND source_id = 'late'",
    )
      .bind(feedId)
      .first<{ id: number }>();
    if (late === null) throw new Error("late entry missing");
    await env.DB.prepare(
      "INSERT INTO entry_states (entry_id, is_read, is_starred, updated_at) VALUES (?, 0, 0, ?)",
    )
      .bind(late.id, cutoff + 1)
      .run();

    const response = await markAll("user/-/state/com.google/reading-list", cutoff);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK\n");

    expect(await unread("e.feed_id = ? AND e.ingested_at <= ?", [feedId, cutoff])).toBe(0);
    expect(await unread("e.feed_id = ?", [feedId])).toBe(1);

    const repeated = await markAll("user/-/state/com.google/reading-list", cutoff);
    expect(repeated.status).toBe(200);
    expect(await unread("e.feed_id = ?", [feedId])).toBe(1);
  });

  it("limits feed-scoped mark-all to the selected feed", async () => {
    const base = Date.now() - 100_000;
    const first = await seedEntries("bulk-feed-a", 4, base);
    const second = await seedEntries("bulk-feed-b", 3, base);

    expect((await markAll(`feed/${first}`)).status).toBe(200);
    expect(await unread("e.feed_id = ?", [first])).toBe(0);
    expect(await unread("e.feed_id = ?", [second])).toBe(3);
  });

  it("limits folder-scoped mark-all to current folder memberships", async () => {
    const base = Date.now() - 100_000;
    const first = await seedEntries("bulk-folder-a", 2, base);
    const second = await seedEntries("bulk-folder-b", 2, base);
    const outside = await seedEntries("bulk-folder-out", 2, base);
    await addFolderMembership(env.DB, first, "Inbox Group", base + 10);
    await addFolderMembership(env.DB, second, "Inbox Group", base + 10);

    const response = await markAll("user/-/label/Inbox Group");
    expect(response.status).toBe(200);
    expect(await unread("e.feed_id IN (?, ?)", [first, second])).toBe(0);
    expect(await unread("e.feed_id = ?", [outside])).toBe(2);

    const folderStream = await exports.default.fetch(
      new Request(
        `${root}/stream/items/ids?s=${encodeURIComponent("user/-/label/Inbox Group")}&xt=${encodeURIComponent("user/-/state/com.google/read")}`,
        { headers: { Authorization: authHeaders.Authorization } },
      ),
    );
    expect(folderStream.status).toBe(200);
    const payload = (await folderStream.json()) as { itemRefs: Array<{ id: string }> };
    expect(payload.itemRefs).toHaveLength(0);
  });
});
