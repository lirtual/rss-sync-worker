import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const headers = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const post = (path: string, values: Array<[string, string]>) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(values),
    }),
  );

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>State Wire</title><link>https://state-wire.example/</link>
<item><guid>state-1</guid><title>One</title><link>https://state-wire.example/1</link></item>
<item><guid>state-2</guid><title>Two</title><link>https://state-wire.example/2</link></item>
</channel></rss>`;

const setup = async () => {
  const now = 1_802_000_000_000;
  const feedId = await ensureSubscription(env.DB, "https://state-wire.example/feed.xml", now);
  const dispatch = await claimDispatch(env.DB, feedId, now);
  if (dispatch === null) throw new Error("expected dispatch");
  await processRefreshMessage(
    env,
    dispatch,
    now + 1,
    async () =>
      new Response(rss, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  );

  const rows = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ? ORDER BY id")
    .bind(feedId)
    .all<{ id: number }>();
  if (rows.results.length !== 2) throw new Error("expected entries");

  const cutoff = now + 10_000;
  await env.DB.batch([
    env.DB.prepare("UPDATE entries SET ingested_at = ?, updated_at = ? WHERE id = ?").bind(
      cutoff - 1_000,
      cutoff - 1_000,
      rows.results[0]?.id,
    ),
    env.DB.prepare("UPDATE entries SET ingested_at = ?, updated_at = ? WHERE id = ?").bind(
      cutoff + 1_000,
      cutoff + 1_000,
      rows.results[1]?.id,
    ),
    env.DB.prepare("UPDATE entry_states SET is_read = 0, updated_at = ?").bind(now + 2),
  ]);

  return { feedId, ids: rows.results.map((row) => row.id), cutoff };
};

describe("Reader-state wire semantics", () => {
  it("treats removing kept-unread as read", async () => {
    const { ids } = await setup();
    const entryId = ids[0];
    if (entryId === undefined) throw new Error("expected entry");

    const response = await post("edit-tag", [
      ["i", String(entryId)],
      ["r", "user/1/state/com.google/kept-unread"],
    ]);
    expect(response.status).toBe(200);

    const state = await env.DB.prepare("SELECT is_read AS isRead FROM entry_states WHERE entry_id = ?")
      .bind(entryId)
      .first<{ isRead: number }>();
    expect(state?.isRead).toBe(1);
  });

  it("rejects contradictory read or starred mutations without partial updates", async () => {
    const { ids } = await setup();
    const entryId = ids[0];
    if (entryId === undefined) throw new Error("expected entry");

    const readConflict = await post("edit-tag", [
      ["i", String(entryId)],
      ["a", "user/-/state/com.google/read"],
      ["r", "user/-/state/com.google/read"],
    ]);
    expect(readConflict.status).toBe(400);

    const starConflict = await post("edit-tag", [
      ["i", String(entryId)],
      ["a", "user/-/state/com.google/starred"],
      ["r", "user/-/state/com.google/starred"],
    ]);
    expect(starConflict.status).toBe(400);

    const state = await env.DB.prepare(
      "SELECT is_read AS isRead, is_starred AS isStarred FROM entry_states WHERE entry_id = ?",
    )
      .bind(entryId)
      .first<{ isRead: number; isStarred: number }>();
    expect(state).toEqual({ isRead: 0, isStarred: 0 });
  });

  it.each([
    ["seconds", (ms: number) => String(Math.floor(ms / 1_000))],
    ["milliseconds", (ms: number) => String(ms)],
    ["microseconds", (ms: number) => String(ms * 1_000)],
  ])("accepts mark-all cutoff in %s", async (_label, encode) => {
    const { feedId, ids, cutoff } = await setup();
    const response = await post("mark-all-as-read", [
      ["s", `feed/${feedId}`],
      ["ts", encode(cutoff)],
    ]);
    expect(response.status).toBe(200);

    const states = await env.DB.prepare(
      `SELECT es.entry_id AS entryId, es.is_read AS isRead
       FROM entry_states es
       WHERE es.entry_id IN (?, ?)
       ORDER BY es.entry_id`,
    )
      .bind(ids[0], ids[1])
      .all<{ entryId: number; isRead: number }>();
    expect(states.results.map((row) => row.isRead)).toEqual([1, 0]);
  });

  it.each(["123", "-1", "not-a-time"])("rejects unsafe mark-all timestamp %s", async (ts) => {
    const { feedId } = await setup();
    const response = await post("mark-all-as-read", [
      ["s", `feed/${feedId}`],
      ["ts", ts],
    ]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "BadTimestamp" });
  });
});
