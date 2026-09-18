import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerHeaders = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const requestReader = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`https://rss-sync.test/api/reader/reader/api/0/${path}`, {
      ...init,
      headers: {
        Authorization: readerHeaders.Authorization,
        ...(init?.headers ?? {}),
      },
    }),
  );

const postReader = (path: string, values: Array<[string, string]>) => {
  const body = new URLSearchParams();
  for (const [key, value] of values) body.append(key, value);
  return requestReader(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
};

const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Parity Feed</title><link>https://parity.example/</link>
<item><guid>parity-1</guid><title>Parity One</title><link>https://parity.example/1</link><description><![CDATA[<p>One</p>]]></description></item>
<item><guid>parity-2</guid><title>Parity Two</title><link>https://parity.example/2</link><description><![CDATA[<p>Two</p>]]></description></item>
</channel></rss>`;

describe("deployed Worker parity", () => {
  it("reproduces the deployed Reeder read-side surface from GitHub source", async () => {
    const now = 1_801_500_000_000;
    const feedId = await ensureSubscription(env.DB, "https://parity.example/feed.xml", now);
    const dispatch = await claimDispatch(env.DB, feedId, now);
    if (dispatch === null) throw new Error("expected dispatch");
    await processRefreshMessage(
      env,
      dispatch,
      now + 1,
      async () =>
        new Response(feed, { status: 200, headers: { "content-type": "application/rss+xml" } }),
    );

    const folderEdit = await postReader("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["a", "user/1/label/Parity"],
    ]);
    expect(folderEdit.status).toBe(200);

    const tagsResponse = await requestReader("tag/list");
    expect(tagsResponse.status).toBe(200);
    const tags = (await tagsResponse.json()) as {
      tags: Array<{ id: string; label?: string; type?: string }>;
    };
    expect(tags.tags).toContainEqual({ id: "user/-/state/com.google/starred" });
    expect(tags.tags).toContainEqual({
      id: "user/-/label/Parity",
      label: "Parity",
      type: "folder",
    });

    const unreadResponse = await requestReader("unread-count");
    expect(unreadResponse.status).toBe(200);
    const unread = (await unreadResponse.json()) as {
      unreadcounts: Array<{ id: string; count: number; newestItemTimestampUsec: string }>;
    };
    expect(unread.unreadcounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user/-/state/com.google/reading-list",
          count: 0,
        }),
        expect.objectContaining({ id: `feed/${feedId}`, count: 0 }),
        expect.objectContaining({ id: "user/-/label/Parity", count: 0 }),
      ]),
    );

    const idsResponse = await requestReader(
      `stream/items/ids?s=${encodeURIComponent("user/1/state/com.google/reading-list")}&n=10&r=o`,
    );
    expect(idsResponse.status).toBe(200);
    const ids = (await idsResponse.json()) as { itemRefs: Array<{ id: string }> };
    expect(ids.itemRefs).toHaveLength(2);
    expect(ids.itemRefs.every((item) => /^\d+$/u.test(item.id))).toBe(true);

    const contents = new URLSearchParams();
    for (const item of ids.itemRefs) contents.append("i", item.id);
    const contentsResponse = await requestReader("stream/items/contents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: contents,
    });
    expect(contentsResponse.status).toBe(200);
    const contentsBody = (await contentsResponse.json()) as {
      direction: string;
      id: string;
      title: string;
      author: string;
      items: Array<{ summary?: { content: string } }>;
    };
    expect(contentsBody).toMatchObject({
      direction: "ltr",
      id: "user/-/state/com.google/reading-list",
      title: "Reading List",
      author: "test-reader",
    });
    expect(contentsBody.items).toHaveLength(2);
    expect(contentsBody.items[0]?.summary?.content).toContain("<p>");
  });

  it("reproduces deployed subscription response and URL-form subscribe behavior", async () => {
    const quickadd = await postReader("subscription/quickadd", [
      ["quickadd", "https://quickadd.example/feed.xml"],
    ]);
    expect(quickadd.status).toBe(200);
    const quickaddBody = (await quickadd.json()) as {
      numResults: number;
      query: string;
      streamId: string;
      streamName: string;
    };
    expect(quickaddBody).toMatchObject({
      numResults: 1,
      query: "https://quickadd.example/feed.xml",
      streamName: "",
    });
    expect(quickaddBody.streamId).toMatch(/^feed\/\d+$/u);

    const subscribe = await postReader("subscription/edit", [
      ["s", "feed/https://url-form.example/feed.xml"],
      ["ac", "subscribe"],
    ]);
    expect(subscribe.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT s.active AS active FROM subscriptions s JOIN feeds f ON f.id = s.feed_id WHERE f.canonical_feed_url = ?",
    )
      .bind("https://url-form.example/feed.xml")
      .first<{ active: number }>();
    expect(row?.active).toBe(1);
  });
});
