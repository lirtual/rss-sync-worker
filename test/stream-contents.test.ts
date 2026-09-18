import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseItemId } from "../src/protocol";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const auth = { Authorization: "GoogleLogin auth=test-reader-token" };

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Direct Stream</title><link>https://direct.example/</link>
<item><guid>direct-1</guid><title>One</title><link>https://direct.example/1</link></item>
<item><guid>direct-2</guid><title>Two</title><link>https://direct.example/2</link></item>
<item><guid>direct-3</guid><title>Three</title><link>https://direct.example/3</link></item>
</channel></rss>`;

const fetchReader = (path: string) =>
  exports.default.fetch(new Request(`${root}/${path}`, { headers: auth }));

const setup = async () => {
  const now = 1_801_800_000_000;
  const feedId = await ensureSubscription(env.DB, "https://direct.example/feed.xml", now);
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

  const entries = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ? ORDER BY id")
    .bind(feedId)
    .all<{ id: number }>();
  if (entries.results.length !== 3) throw new Error("expected entries");
  for (const [index, row] of entries.results.entries()) {
    const at = now + (index + 1) * 1_000;
    await env.DB.prepare("UPDATE entries SET ingested_at = ?, updated_at = ? WHERE id = ?")
      .bind(at, at, row.id)
      .run();
  }

  const [first, second] = entries.results;
  if (first === undefined || second === undefined) throw new Error("expected entry ids");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE entry_states SET is_read = 0, read_changed_at = ?, updated_at = ? WHERE entry_id = ?",
    ).bind(now + 1_000, now + 1_000, first.id),
    env.DB.prepare(
      "UPDATE entry_states SET is_starred = 1, starred_changed_at = ?, updated_at = ? WHERE entry_id = ?",
    ).bind(now + 2_000, now + 2_000, second.id),
  ]);

  const folder = await exports.default.fetch(
    new Request(`${root}/subscription/edit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["T", "test-reader-token"],
        ["s", `feed/${feedId}`],
        ["ac", "edit"],
        ["a", "user/-/label/Direct"],
      ]),
    }),
  );
  expect(folder.status).toBe(200);

  return { feedId, now, ids: entries.results.map((row) => row.id) };
};

const itemIds = async (query: string) => {
  const params = new URLSearchParams(query);
  params.set("output", "json");
  const response = await fetchReader(`stream/items/ids?${params.toString()}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    itemRefs: Array<{ id: string }>;
    continuation?: string;
  };
};

const streamContents = async (stream: string, query = "") => {
  const response = await fetchReader(
    `stream/contents/${encodeURIComponent(stream)}${query === "" ? "" : `?${query}`}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    title: string;
    items: Array<{ id: string }>;
    continuation?: string;
  };
};

const numericContentsIds = (items: Array<{ id: string }>) =>
  items.map((item) => parseItemId(item.id)).filter((id): id is number => id !== null);

describe("Reeder direct stream contents", () => {
  it("selects the same logical entries as stream/items/ids", async () => {
    const { feedId } = await setup();
    const cases = [
      ["user/1/state/com.google/reading-list", ""],
      [`feed/${feedId}`, ""],
      ["user/-/label/Direct", ""],
      ["user/-/state/com.google/starred", ""],
      [
        "user/-/state/com.google/reading-list",
        `xt=${encodeURIComponent("user/1/state/com.google/read")}`,
      ],
    ] as const;

    for (const [stream, extra] of cases) {
      const query = `s=${encodeURIComponent(stream)}&n=10${extra === "" ? "" : `&${extra}`}`;
      const ids = await itemIds(query);
      const contents = await streamContents(stream, `n=10${extra === "" ? "" : `&${extra}`}`);
      expect(numericContentsIds(contents.items)).toEqual(
        ids.itemRefs.map((item) => Number(item.id)),
      );
      expect(contents.id).toBe(stream.replace(/^user\/1\//u, "user/-/"));
    }
  });

  it("shares ordering, time bounds, and opaque continuation semantics", async () => {
    const { now } = await setup();

    const oldest = await streamContents(
      "user/-/state/com.google/reading-list",
      `n=2&r=o&ot=${Math.floor((now + 1_000) / 1_000)}&nt=${Math.floor((now + 3_000) / 1_000)}`,
    );
    expect(oldest.items).toHaveLength(2);
    expect(oldest.continuation).toBeTypeOf("string");

    const next = await streamContents(
      "user/-/state/com.google/reading-list",
      `n=2&r=o&c=${encodeURIComponent(oldest.continuation ?? "")}`,
    );
    expect(next.items).toHaveLength(1);

    const firstIds = numericContentsIds(oldest.items);
    const nextIds = numericContentsIds(next.items);
    expect(new Set([...firstIds, ...nextIds]).size).toBe(3);
    expect(firstIds[0]).toBeLessThan(firstIds[1] ?? Number.MAX_SAFE_INTEGER);
  });

  it("rejects unsupported exclusion streams explicitly", async () => {
    const response = await fetchReader(
      `stream/items/ids?output=json&s=${encodeURIComponent("user/-/state/com.google/reading-list")}&xt=${encodeURIComponent("user/-/label/unsupported")}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "UnsupportedFilter" });
  });
});
