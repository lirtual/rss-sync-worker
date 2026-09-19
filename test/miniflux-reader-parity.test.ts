import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/feed/parser";
import { googleEntry, parseItemId, type ReaderEntry } from "../src/protocol";
import { ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";

const getReader = (path: string) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      headers: { Authorization: "GoogleLogin auth=test-reader-token" },
    }),
  );

const postReader = (path: string, values: Array<[string, string]>) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([["T", "test-reader-token"], ...values]),
    }),
  );

describe("pinned Miniflux Google Reader baseline", () => {
  it("supports ClientLogin JSON output and JSON 401 errors", async () => {
    const ok = await exports.default.fetch(
      new Request("https://rss-sync.test/api/reader/accounts/ClientLogin", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          Email: "test-reader",
          Passwd: "test-reader-token",
          output: "json",
        }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      SID: "test-reader-token",
      LSID: "test-reader-token",
      Auth: "test-reader-token",
    });

    const denied = await exports.default.fetch(
      new Request("https://rss-sync.test/api/reader/accounts/ClientLogin", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Email: "test-reader", Passwd: "wrong" }),
      }),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error_message: "access unauthorized" });
  });

  it("uses Authorization for GET and T for POST", async () => {
    const deniedGet = await exports.default.fetch(new Request(`${root}/token`));
    expect(deniedGet.status).toBe(401);
    expect(deniedGet.headers.get("X-Reader-Google-Bad-Token")).toBe("true");
    expect(await deniedGet.text()).toBe("Unauthorized");

    const feedId = await ensureSubscription(
      env.DB,
      "https://auth-baseline.example/feed.xml",
      Date.now(),
    );
    const headerOnlyPost = await exports.default.fetch(
      new Request(`${root}/subscription/edit`, {
        method: "POST",
        headers: {
          Authorization: "GoogleLogin auth=test-reader-token",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams([
          ["s", `feed/${feedId}`],
          ["ac", "edit"],
          ["t", "must-not-apply"],
        ]),
      }),
    );
    expect(headerOnlyPost.status).toBe(401);

    const tokenPost = await postReader("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "edit"],
      ["t", "Baseline"],
    ]);
    expect(tokenPost.status).toBe(200);
    expect(await tokenPost.text()).toBe("OK");
  });

  it("requires output=json on Miniflux JSON read endpoints", async () => {
    for (const path of ["subscription/list", "tag/list"]) {
      const denied = await getReader(path);
      expect(denied.status).toBe(400);
      const ok = await getReader(`${path}?output=json`);
      expect(ok.status).toBe(200);
    }

    const missing = await getReader(
      `stream/items/ids?s=${encodeURIComponent("user/-/state/com.google/reading-list")}`,
    );
    expect(missing.status).toBe(400);
    const ok = await getReader(
      `stream/items/ids?output=json&s=${encodeURIComponent("user/-/state/com.google/reading-list")}`,
    );
    expect(ok.status).toBe(200);
  });

  it("supports repeated unsubscribe streams and exact OK", async () => {
    const now = Date.now();
    const first = await ensureSubscription(env.DB, "https://multi-unsub-a.example/feed.xml", now);
    const second = await ensureSubscription(env.DB, "https://multi-unsub-b.example/feed.xml", now);
    const response = await postReader("subscription/edit", [
      ["ac", "unsubscribe"],
      ["s", `feed/${first}`],
      ["s", `feed/${second}`],
    ]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");

    const states = await env.DB.prepare(
      "SELECT feed_id AS feedId, active FROM subscriptions WHERE feed_id IN (?, ?) ORDER BY feed_id",
    )
      .bind(first, second)
      .all<{ feedId: number; active: number }>();
    expect(states.results.map((row) => row.active)).toEqual([0, 0]);
  });

  it("treats edit-tag a/r as body-only fields", async () => {
    const queryOnly = await exports.default.fetch(
      new Request(
        `${root}/edit-tag?T=test-reader-token&i=1&a=${encodeURIComponent("user/-/state/com.google/read")}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
      ),
    );
    expect(queryOnly.status).toBe(400);
  });

  it("accepts Miniflux item ID formats including numeric-only 16-char hex", () => {
    expect(parseItemId("tag:google.com,2005:reader/item/000000000000048c")).toBe(1164);
    expect(parseItemId("000000000000048c")).toBe(1164);
    expect(parseItemId("0000000000001234")).toBe(0x1234);
    expect(parseItemId("12345")).toBe(12345);
  });

  it("returns []/200 for authenticated unimplemented Reader endpoints", async () => {
    const get = await getReader("preference/list");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual([]);

    const post = await postReader("friend/edit", []);
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual([]);
  });
});

describe("Reeder article time semantics", () => {
  it("preserves publisher pubDate separately from first ingestion time", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>爱范儿</title>
<item><guid>1680982</guid><title>iPhone 18</title>
<pubDate>Sat, 19 Sep 2026 04:00:24 +0000</pubDate></item>
<item><guid>1680956</guid><title>早报</title>
<pubDate>Sat, 19 Sep 2026 00:59:13 +0000</pubDate></item>
</channel></rss>`;
    const parsed = parseFeed(xml);
    const entryBase: ReaderEntry = {
      id: 1,
      feedId: 1,
      feedTitle: "爱范儿",
      feedSiteUrl: null,
      folderNames: [],
      title: "Article",
      url: null,
      author: null,
      publishedAt: null,
      sourceUpdatedAt: null,
      ingestedAt: Date.parse("2026-09-19T01:20:00.000Z"),
      updatedAt: Date.parse("2026-09-19T01:20:00.000Z"),
      contentHtml: "",
      isRead: 0,
      isStarred: 0,
    };

    for (const [index, expectedIso] of [
      "2026-09-19T04:00:24.000Z",
      "2026-09-19T00:59:13.000Z",
    ].entries()) {
      const publishedAt = parsed.entries[index]?.publishedAt ?? null;
      expect(publishedAt).toBe(Date.parse(expectedIso));
      const item = googleEntry({ ...entryBase, publishedAt });
      expect(item.published).toBe(Math.floor(Date.parse(expectedIso) / 1_000));
      expect(item.timestampUsec).toBe(String(Date.parse(expectedIso) * 1_000));
      expect(item.crawlTimeMsec).toBe(String(entryBase.ingestedAt));
    }
  });

  it("falls back to first ingestion time when the publisher has no date", () => {
    const ingestedAt = Date.parse("2026-09-19T01:20:00.000Z");
    const item = googleEntry({
      id: 2,
      feedId: 1,
      feedTitle: "Undated feed",
      feedSiteUrl: null,
      folderNames: [],
      title: "Undated article",
      url: null,
      author: null,
      publishedAt: null,
      sourceUpdatedAt: null,
      ingestedAt,
      updatedAt: ingestedAt,
      contentHtml: "",
      isRead: 0,
      isStarred: 0,
    });
    expect(item.timestampUsec).toBe(String(ingestedAt * 1_000));
    expect(item.published).toBe(Math.floor(ingestedAt / 1_000));
    expect(item.crawlTimeMsec).toBe(String(ingestedAt));
  });
});
