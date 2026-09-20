import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addFolderMembership, updateSubscription } from "../src/folder-store";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const auth = { Authorization: "GoogleLogin auth=test-reader-token" };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fetchReader = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      ...init,
      headers: { ...auth, ...(init?.headers ?? {}) },
    }),
  );

const normalizeSubscription = (value: {
  id: string;
  url: string;
  htmlUrl: string;
  title: string;
  categories: Array<{ id: string; label: string; type: string }>;
  iconUrl: string;
}) => ({
  ...value,
  id: value.id.replace(/^feed\/\d+$/u, "feed/<id>"),
  iconUrl: value.iconUrl === "" ? "" : "<icon-url>",
});

const normalizeItem = (value: Record<string, unknown>) => ({
  ...value,
  id: "<item-id>",
  timestampUsec: "<timestamp-usec>",
  crawlTimeMsec: "<crawl-msec>",
  published: "<published-sec>",
  updated: "<updated-sec>",
  origin: {
    ...(value.origin as Record<string, unknown>),
    streamId: "feed/<id>",
  },
});

const normalizeItems = (items: Array<Record<string, unknown>>) =>
  [...items]
    .sort((left, right) => String(left.title).localeCompare(String(right.title)))
    .map(normalizeItem);

describe("Reeder v0.2 value-level golden contract", () => {
  it("locks subscription, item, icon, folder, enclosure and unread values", async () => {
    const now = 1_780_500_000_000;
    const feedUrl = "https://golden.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, feedUrl, now);
    const dispatch = await claimDispatch(env.DB, feedId, now);
    if (dispatch === null) throw new Error("expected dispatch");

    const feed = `<rss version="2.0"><channel>
<title>Golden Feed</title><link>https://golden.example/</link>
<image><url>/icon.png</url></image>
<item><guid>normal</guid><title>Normal Item</title><link>/normal</link><author>Alice</author>
<description><![CDATA[<p>Normal body</p>]]></description>
<enclosure url="/audio.mp3" type="audio/mpeg" length="10"/>
<enclosure url="https://cdn.example/video.mp4" type="video/mp4" length="20"/>
</item>
<item><guid>bare</guid><title>Bare Item</title><description>Bare body</description></item>
</channel></rss>`;

    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === feedUrl) {
        return new Response(feed, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        });
      }
      if (url === "https://golden.example/icon.png") {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    expect(await processRefreshMessage(env, dispatch, now + 1, fetcher)).toBe("processed");
    await updateSubscription(env.DB, feedId, { title: "Custom Source" }, now + 2);
    await addFolderMembership(env.DB, feedId, "Alpha", now + 3);
    await addFolderMembership(env.DB, feedId, "Beta", now + 4);

    const entries = await env.DB.prepare(
      "SELECT id, source_id AS sourceId FROM entries WHERE feed_id = ? ORDER BY source_id",
    )
      .bind(feedId)
      .all<{ id: number; sourceId: string }>();
    const bare = entries.results.find((entry) => entry.sourceId === "bare");
    const normal = entries.results.find((entry) => entry.sourceId === "normal");
    if (bare === undefined || normal === undefined) throw new Error("expected golden entries");
    await env.DB.prepare(
      "UPDATE entry_states SET is_read = 0, is_starred = 1, updated_at = ? WHERE entry_id = ?",
    )
      .bind(now + 5, normal.id)
      .run();

    const noIconUrl = "https://no-icon.example/feed.xml";
    const noIconId = await ensureSubscription(env.DB, noIconUrl, now + 10);
    const noIconDispatch = await claimDispatch(env.DB, noIconId, now + 10);
    if (noIconDispatch === null) throw new Error("expected no-icon dispatch");
    const noIconFetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === noIconUrl) {
        return new Response(
          '<rss version="2.0"><channel><title>Empty Icon</title></channel></rss>',
          { status: 200, headers: { "content-type": "application/rss+xml" } },
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    expect(await processRefreshMessage(env, noIconDispatch, now + 11, noIconFetcher)).toBe(
      "processed",
    );

    const listResponse = await fetchReader("subscription/list?output=json");
    const listBody = (await listResponse.json()) as {
      subscriptions: Array<{
        id: string;
        url: string;
        htmlUrl: string;
        title: string;
        categories: Array<{ id: string; label: string; type: string }>;
        iconUrl: string;
      }>;
    };
    const custom = listBody.subscriptions.find((item) => item.id === `feed/${feedId}`);
    const empty = listBody.subscriptions.find((item) => item.id === `feed/${noIconId}`);
    if (custom === undefined || empty === undefined) throw new Error("expected subscriptions");
    expect(normalizeSubscription(custom)).toEqual({
      id: "feed/<id>",
      url: feedUrl,
      htmlUrl: "https://golden.example/",
      title: "Custom Source",
      categories: [
        { id: "user/-/label/Alpha", label: "Alpha", type: "folder" },
        { id: "user/-/label/Beta", label: "Beta", type: "folder" },
      ],
      iconUrl: "<icon-url>",
    });
    expect(normalizeSubscription(empty)).toEqual({
      id: "feed/<id>",
      url: noIconUrl,
      htmlUrl: "",
      title: "Empty Icon",
      categories: [],
      iconUrl: "",
    });

    const form = new URLSearchParams([
      ["T", "test-reader-token"],
      ["output", "json"],
      ["i", String(normal.id)],
      ["i", String(bare.id)],
    ]);
    const itemResponse = await fetchReader("stream/items/contents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const itemBody = (await itemResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(normalizeItems(itemBody.items)).toEqual([
      {
        id: "<item-id>",
        title: "Bare Item",
        timestampUsec: "<timestamp-usec>",
        crawlTimeMsec: "<crawl-msec>",
        published: "<published-sec>",
        updated: "<updated-sec>",
        alternate: [],
        canonical: [],
        content: { direction: "ltr", content: "Bare body" },
        summary: { direction: "ltr", content: "Bare body" },
        origin: {
          streamId: "feed/<id>",
          title: "Custom Source",
          htmlUrl: "https://golden.example/",
        },
        categories: [
          "user/-/state/com.google/reading-list",
          "user/-/state/com.google/read",
          "user/-/label/Alpha",
          "user/-/label/Beta",
        ],
        enclosure: [],
        author: "",
      },
      {
        id: "<item-id>",
        title: "Normal Item",
        timestampUsec: "<timestamp-usec>",
        crawlTimeMsec: "<crawl-msec>",
        published: "<published-sec>",
        updated: "<updated-sec>",
        alternate: [{ href: "https://golden.example/normal", type: "text/html" }],
        canonical: [{ href: "https://golden.example/normal" }],
        content: { direction: "ltr", content: "<p>Normal body</p>" },
        summary: { direction: "ltr", content: "<p>Normal body</p>" },
        origin: {
          streamId: "feed/<id>",
          title: "Custom Source",
          htmlUrl: "https://golden.example/",
        },
        categories: [
          "user/-/state/com.google/reading-list",
          "user/-/state/com.google/starred",
          "user/-/label/Alpha",
          "user/-/label/Beta",
        ],
        enclosure: [
          { url: "https://golden.example/audio.mp3", type: "audio/mpeg" },
          { url: "https://cdn.example/video.mp4", type: "video/mp4" },
        ],
        author: "Alice",
      },
    ]);

    const direct = await fetchReader(
      `stream/contents/${encodeURIComponent(`feed/${feedId}`)}?n=10&r=o`,
    );
    const directBody = (await direct.json()) as { items: Array<Record<string, unknown>> };
    expect(normalizeItems(directBody.items)).toEqual(normalizeItems(itemBody.items));

    const mark = await fetchReader("mark-all-as-read", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["T", "test-reader-token"],
        ["s", "user/-/state/com.google/reading-list"],
      ]),
    });
    expect(mark.status).toBe(200);

    const unread = await fetchReader("unread-count");
    expect(await unread.json()).toEqual({
      max: 0,
      unreadcounts: [
        {
          id: "user/-/state/com.google/reading-list",
          count: 0,
          newestItemTimestampUsec: "0",
        },
      ],
    });
  });

  it("locks unknown-endpoint and unsupported label-removal behavior", async () => {
    const unknown = await fetchReader("not-a-real-reader-endpoint?output=json");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual([]);

    const feedId = await ensureSubscription(
      env.DB,
      "https://golden-label-remove.example/feed.xml",
      Date.now() - 1_000,
    );
    const removal = await exports.default.fetch(
      new Request(`${root}/subscription/edit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
          ["T", "test-reader-token"],
          ["s", `feed/${feedId}`],
          ["ac", "edit"],
          ["r", "user/-/label/Alpha"],
        ]),
      }),
    );
    expect(removal.status).toBe(400);
    expect(await removal.json()).toEqual({
      error_message: "removing subscription labels is not supported",
    });
  });
});
