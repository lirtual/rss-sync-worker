import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const readerHeaders = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};
const root = "https://rss-sync.test/api/reader/reader/api/0";
const readState = "user/-/state/com.google/read";
const starredState = "user/-/state/com.google/starred";
const keptUnreadState = "user/-/state/com.google/kept-unread";

const seedEntry = async (key: string, now: number): Promise<number> => {
  const feed = await env.DB.prepare(
    `INSERT INTO feeds (canonical_feed_url, title, next_fetch_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(`https://${key}.example/feed.xml`, key, now, now, now)
    .first<{ id: number }>();
  if (feed === null) throw new Error("failed to seed feed");

  await env.DB.prepare(
    `INSERT INTO subscriptions (feed_id, active, bootstrapped_at, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?)`,
  )
    .bind(feed.id, now, now, now)
    .run();

  const entry = await env.DB.prepare(
    `INSERT INTO entries (
       feed_id, identity_key, source_id, title, url, author, published_at,
       source_updated_at, ingested_at, last_source_seen_at, content_status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, 'stored', ?, ?)
     RETURNING id`,
  )
    .bind(
      feed.id,
      "a".repeat(64),
      `${key}-source`,
      `${key} title`,
      `https://${key}.example/article`,
      now,
      now,
      now,
      now,
      now,
    )
    .first<{ id: number }>();
  if (entry === null) throw new Error("failed to seed entry");

  await env.DB.prepare(
    `INSERT INTO entry_contents (entry_id, content_html, content_hash, encoded_size_bytes, updated_at)
     VALUES (?, '<p>body</p>', ?, 11, ?)`,
  )
    .bind(entry.id, "b".repeat(64), now)
    .run();
  await env.DB.prepare(
    `INSERT INTO entry_states (entry_id, is_read, is_starred, updated_at)
     VALUES (?, 0, 0, ?)`,
  )
    .bind(entry.id, now)
    .run();
  return entry.id;
};

const editTag = async (id: number, fields: Record<string, string>): Promise<Response> =>
  exports.default.fetch(
    new Request(`${root}/edit-tag`, {
      method: "POST",
      headers: readerHeaders,
      body: new URLSearchParams({ T: "test-reader-token", i: String(id), ...fields }),
    }),
  );

const state = async (id: number): Promise<{ isRead: number; isStarred: number }> => {
  const row = await env.DB.prepare(
    "SELECT is_read AS isRead, is_starred AS isStarred FROM entry_states WHERE entry_id = ?",
  )
    .bind(id)
    .first<{ isRead: number; isStarred: number }>();
  if (row === null) throw new Error("missing state");
  return row;
};

const streamIds = async (query: URLSearchParams): Promise<number[]> => {
  const response = await exports.default.fetch(
    new Request(`${root}/stream/items/ids?${new URLSearchParams([
      ["output", "json"],
      ...query.entries(),
    ]).toString()}`, {
      headers: { Authorization: readerHeaders.Authorization },
    }),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { itemRefs: Array<{ id: string }> };
  return payload.itemRefs.map((item) => Number(item.id));
};

describe("reader state mutations", () => {
  it("marks read and unread idempotently and updates unread streams", async () => {
    const id = await seedEntry("state-read", 1_810_000_000_000);

    expect((await editTag(id, { a: readState })).status).toBe(200);
    expect((await editTag(id, { a: readState })).status).toBe(200);
    expect(await state(id)).toEqual({ isRead: 1, isStarred: 0 });

    const unreadWhileRead = await streamIds(
      new URLSearchParams({ s: "user/-/state/com.google/reading-list", xt: readState }),
    );
    expect(unreadWhileRead).not.toContain(id);

    expect((await editTag(id, { r: readState, a: keptUnreadState })).status).toBe(200);
    expect((await editTag(id, { r: readState })).status).toBe(200);
    expect(await state(id)).toEqual({ isRead: 0, isStarred: 0 });

    const unreadAgain = await streamIds(
      new URLSearchParams({ s: "user/-/state/com.google/reading-list", xt: readState }),
    );
    expect(unreadAgain).toContain(id);
  });

  it("stars and unstars idempotently and updates starred streams", async () => {
    const id = await seedEntry("state-star", 1_810_100_000_000);

    expect((await editTag(id, { a: starredState })).status).toBe(200);
    expect((await editTag(id, { a: starredState })).status).toBe(200);
    expect(await state(id)).toEqual({ isRead: 0, isStarred: 1 });
    expect(await streamIds(new URLSearchParams({ s: starredState }))).toContain(id);

    expect((await editTag(id, { r: starredState })).status).toBe(200);
    expect((await editTag(id, { r: starredState })).status).toBe(200);
    expect(await state(id)).toEqual({ isRead: 0, isStarred: 0 });
    expect(await streamIds(new URLSearchParams({ s: starredState }))).not.toContain(id);
  });
});
