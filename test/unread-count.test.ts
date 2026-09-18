import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const auth = { Authorization: "GoogleLogin auth=test-reader-token" };
const root = "https://rss-sync.test/api/reader/reader/api/0";

const feed = (name: string, count: number) => {
  const items = Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return `<item><guid>${name}-${id}</guid><title>${name} ${id}</title><link>https://${name}.example/${id}</link></item>`;
  }).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${name}</title><link>https://${name}.example/</link>${items}</channel></rss>`;
};

const ingest = async (url: string, body: string, now: number) => {
  const feedId = await ensureSubscription(env.DB, url, now);
  const dispatch = await claimDispatch(env.DB, feedId, now);
  if (dispatch === null) throw new Error("expected dispatch");
  await processRefreshMessage(
    env,
    dispatch,
    now + 1,
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      }),
  );
  return feedId;
};

const editFolder = async (feedId: number, folder: string) =>
  exports.default.fetch(
    new Request(`${root}/subscription/edit`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["s", `feed/${feedId}`],
        ["a", `user/-/label/${folder}`],
      ]),
    }),
  );

const getUnread = async () => {
  const response = await exports.default.fetch(
    new Request(`${root}/unread-count`, { headers: auth }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    unreadcounts: Array<{ id: string; count: number; newestItemTimestampUsec: string }>;
  };
};

describe("Reeder unread-count", () => {
  it("counts only unread active entries and reports the newest unread timestamp", async () => {
    const base = 1_801_700_000_000;
    const activeFeed = await ingest(
      "https://unread-active.example/feed.xml",
      feed("unread-active", 2),
      base,
    );
    const zeroFeed = await ingest(
      "https://unread-zero.example/feed.xml",
      feed("unread-zero", 1),
      base + 10,
    );
    expect((await editFolder(activeFeed, "Unread")).status).toBe(200);
    expect((await editFolder(zeroFeed, "Zero")).status).toBe(200);

    const rows = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ? ORDER BY id")
      .bind(activeFeed)
      .all<{ id: number }>();
    const [unreadId, newerReadId] = rows.results.map((row) => row.id);
    if (unreadId === undefined || newerReadId === undefined) throw new Error("expected entries");

    const unreadAt = base + 1_000;
    const newerReadAt = base + 2_000;
    await env.DB.batch([
      env.DB.prepare("UPDATE entries SET ingested_at = ?, updated_at = ? WHERE id = ?").bind(
        unreadAt,
        unreadAt,
        unreadId,
      ),
      env.DB.prepare("UPDATE entries SET ingested_at = ?, updated_at = ? WHERE id = ?").bind(
        newerReadAt,
        newerReadAt,
        newerReadId,
      ),
      env.DB.prepare(
        "UPDATE entry_states SET is_read = 0, read_changed_at = ?, updated_at = ? WHERE entry_id = ?",
      ).bind(unreadAt, unreadAt, unreadId),
    ]);

    const body = await getUnread();
    expect(body.unreadcounts).toEqual(
      expect.arrayContaining([
        {
          id: "user/-/state/com.google/reading-list",
          count: 1,
          newestItemTimestampUsec: String(unreadAt * 1_000),
        },
        {
          id: `feed/${activeFeed}`,
          count: 1,
          newestItemTimestampUsec: String(unreadAt * 1_000),
        },
        {
          id: "user/-/label/Unread",
          count: 1,
          newestItemTimestampUsec: String(unreadAt * 1_000),
        },
      ]),
    );
    expect(body.unreadcounts.some((row) => row.id === `feed/${zeroFeed}`)).toBe(false);
    expect(body.unreadcounts.some((row) => row.id === "user/-/label/Zero")).toBe(false);
  });

  it("keeps the reading-list aggregate when all unread state is cleared", async () => {
    await env.DB.prepare("UPDATE entry_states SET is_read = 1, updated_at = ?")
      .bind(Date.now())
      .run();

    const body = await getUnread();
    expect(body.unreadcounts).toEqual([
      {
        id: "user/-/state/com.google/reading-list",
        count: 0,
        newestItemTimestampUsec: "0",
      },
    ]);
  });
});
