import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const auth = { Authorization: "GoogleLogin auth=test-reader-token" };

const readerItem = async (entryId: number) => {
  const form = new URLSearchParams({
    T: "test-reader-token",
    output: "json",
    i: String(entryId),
  });
  const response = await exports.default.fetch(
    new Request(`${root}/stream/items/contents`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Array<Record<string, unknown>> };
  const item = body.items[0];
  if (item === undefined) throw new Error("expected Reader item");
  return item;
};

const directItem = async (feedId: number) => {
  const response = await exports.default.fetch(
    new Request(`${root}/stream/contents/${encodeURIComponent(`feed/${feedId}`)}?n=10`, {
      headers: auth,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Array<Record<string, unknown>> };
  const item = body.items[0];
  if (item === undefined) throw new Error("expected direct Reader item");
  return item;
};

const editTitle = async (feedId: number, title: string) =>
  exports.default.fetch(
    new Request(`${root}/subscription/edit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["T", "test-reader-token"],
        ["s", `feed/${feedId}`],
        ["ac", "edit"],
        ["t", title],
      ]),
    }),
  );

describe("Reader item metadata semantics", () => {
  it("uses custom source title and stable empty metadata fields across both contents endpoints", async () => {
    const now = 1_780_000_000_000;
    const feedId = await ensureSubscription(env.DB, "https://metadata-v2.example/feed.xml", now);
    const dispatch = await claimDispatch(env.DB, feedId, now);
    if (dispatch === null) throw new Error("expected dispatch");

    const body = `<rss version="2.0"><channel><title>Original Feed</title>
<item><guid>one</guid><title>One</title><description><![CDATA[
<p><a href="/relative">Relative</a>
<img src="./image.png"><audio src="media.mp3"></audio>
<video poster="/poster.jpg"><source src="/movie.mp4"></video>
<a href="javascript:alert(1)">Unsafe</a></p>
]]></description></item></channel></rss>`;
    expect(
      await processRefreshMessage(
        env,
        dispatch,
        now + 1,
        async () =>
          new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } }),
      ),
    ).toBe("processed");

    expect((await editTitle(feedId, "Custom Source")).status).toBe(200);
    const entry = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ?")
      .bind(feedId)
      .first<{ id: number }>();
    if (entry === null) throw new Error("expected entry");

    const [itemContents, streamContents] = await Promise.all([
      readerItem(entry.id),
      directItem(feedId),
    ]);
    for (const item of [itemContents, streamContents]) {
      expect(item.author).toBe("");
      expect(item.alternate).toEqual([]);
      expect(item.canonical).toEqual([]);
      expect(item.enclosure).toEqual([]);
      expect(item.origin).toEqual({
        streamId: `feed/${feedId}`,
        title: "Custom Source",
        htmlUrl: "",
      });

      const content = (item.content as { content: string }).content;
      expect(content).toContain('href="https://metadata-v2.example/relative"');
      expect(content).toContain('src="https://metadata-v2.example/image.png"');
      expect(content).toContain('src="https://metadata-v2.example/media.mp3"');
      expect(content).toContain('poster="https://metadata-v2.example/poster.jpg"');
      expect(content).toContain('src="https://metadata-v2.example/movie.mp4"');
      expect(content).not.toContain("javascript:");
    }

    const list = await exports.default.fetch(
      new Request(`${root}/subscription/list?output=json`, { headers: auth }),
    );
    const listBody = (await list.json()) as {
      subscriptions: Array<{ id: string; title: string }>;
    };
    expect(listBody.subscriptions).toContainEqual(
      expect.objectContaining({ id: `feed/${feedId}`, title: "Custom Source" }),
    );
  });

  it("uses publication time for timestampUsec and ingestion time for crawlTimeMsec", async () => {
    const now = 1_780_200_000_000;
    const feedId = await ensureSubscription(env.DB, "https://timestamp.example/feed.xml", now);
    const dispatch = await claimDispatch(env.DB, feedId, now);
    if (dispatch === null) throw new Error("expected dispatch");

    const published = "Wed, 16 Sep 2026 12:00:00 GMT";
    await processRefreshMessage(
      env,
      dispatch,
      now + 1,
      async () =>
        new Response(
          `<rss version="2.0"><channel><title>Timestamps</title><link>https://timestamp.example/</link>
<item><guid>one</guid><title>One</title><link>https://timestamp.example/one</link><pubDate>${published}</pubDate></item>
</channel></rss>`,
          { status: 200 },
        ),
    );

    const row = await env.DB.prepare(
      "SELECT id, published_at AS publishedAt, ingested_at AS ingestedAt FROM entries WHERE feed_id = ?",
    )
      .bind(feedId)
      .first<{ id: number; publishedAt: number; ingestedAt: number }>();
    if (row === null) throw new Error("expected entry");

    const item = await readerItem(row.id);
    expect(item.timestampUsec).toBe(String(row.publishedAt * 1_000));
    expect(item.crawlTimeMsec).toBe(String(row.ingestedAt));
    expect(item.published).toBe(Math.floor(row.publishedAt / 1_000));
  });

  it("advances effective updated time for content-only edits without resetting state", async () => {
    const now = 1_780_100_000_000;
    const feedId = await ensureSubscription(env.DB, "https://content-update.example/feed.xml", now);
    const first = await claimDispatch(env.DB, feedId, now);
    if (first === null) throw new Error("expected dispatch");

    const rss = (
      content: string,
    ) => `<rss version="2.0"><channel><title>Updates</title><link>https://content-update.example/</link>
<item><guid>same</guid><title>Same</title><link>https://content-update.example/item</link><description><![CDATA[${content}]]></description></item>
</channel></rss>`;
    await processRefreshMessage(
      env,
      first,
      now + 1,
      async () => new Response(rss("<p>First</p>"), { status: 200 }),
    );

    const entry = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ?")
      .bind(feedId)
      .first<{ id: number }>();
    if (entry === null) throw new Error("expected entry");
    await env.DB.prepare(
      "UPDATE entry_states SET is_read = 0, is_starred = 1, updated_at = ? WHERE entry_id = ?",
    )
      .bind(now + 2, entry.id)
      .run();

    const before = await readerItem(entry.id);
    const beforeUpdated = before.updated as number;
    const beforeRow = await env.DB.prepare("SELECT updated_at AS updatedAt FROM entries WHERE id = ?")
      .bind(entry.id)
      .first<{ updatedAt: number }>();
    if (beforeRow === null) throw new Error("expected entry metadata");

    const second = await claimDispatch(env.DB, feedId, now + 5_000);
    if (second === null) throw new Error("expected second dispatch");
    await processRefreshMessage(
      env,
      second,
      now + 5_001,
      async () => new Response(rss("<p>Second</p>"), { status: 200 }),
    );

    const after = await readerItem(entry.id);
    const afterRow = await env.DB.prepare("SELECT updated_at AS updatedAt FROM entries WHERE id = ?")
      .bind(entry.id)
      .first<{ updatedAt: number }>();
    if (afterRow === null) throw new Error("expected updated entry metadata");
    expect(afterRow.updatedAt).toBeGreaterThan(beforeRow.updatedAt);
    expect(after.updated as number).toBeGreaterThan(beforeUpdated);
    expect((after.content as { content: string }).content).toContain("Second");
    expect(after.categories).toEqual(
      expect.arrayContaining([
        "user/-/state/com.google/reading-list",
        "user/-/state/com.google/starred",
      ]),
    );
    expect(after.categories).not.toContain("user/-/state/com.google/read");
  });
});
