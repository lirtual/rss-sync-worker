import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerHeaders = { Authorization: "GoogleLogin auth=test-reader-token" };

const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    ${items}
  </channel>
</rss>`;

const item = (guid: string, title: string, date = "Wed, 16 Sep 2026 12:00:00 GMT") => `
<item>
  <guid>${guid}</guid>
  <title>${title}</title>
  <link>https://example.com/${guid}</link>
  <pubDate>${date}</pubDate>
  <description><![CDATA[<p>${title}</p>]]></description>
</item>`;

const fakeFeed = (body: string) => async (): Promise<Response> =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/rss+xml", etag: '"v1"' },
  });

describe("subscription bootstrap", () => {
  it("quickadd is idempotent and appears in subscription/list", async () => {
    const request = () =>
      exports.default.fetch(
        new Request("https://rss-sync.test/api/reader/reader/api/0/subscription/quickadd", {
          method: "POST",
          headers: {
            ...readerHeaders,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ quickadd: "https://example.net/feed.xml" }),
        }),
      );

    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    const list = await exports.default.fetch(
      new Request("https://rss-sync.test/api/reader/reader/api/0/subscription/list", {
        headers: readerHeaders,
      }),
    );
    expect(list.status).toBe(200);
    const payload = (await list.json()) as { subscriptions: Array<{ url: string }> };
    expect(
      payload.subscriptions.filter((entry) => entry.url === "https://example.net/feed.xml"),
    ).toHaveLength(1);
  });

  it("marks first successful history read and later entries unread", async () => {
    const now = 1_800_000_000_000;
    const feedId = await ensureSubscription(env.DB, "https://example.com/feed.xml", now);
    const firstMessage = await claimDispatch(env.DB, feedId, now);
    expect(firstMessage).not.toBeNull();
    if (firstMessage === null) throw new Error("expected dispatch claim");

    await processRefreshMessage(
      env,
      firstMessage,
      now + 1,
      fakeFeed(rss(item("one", "One") + item("two", "Two"))),
    );

    const bootstrap = await env.DB.prepare(
      `SELECT s.bootstrapped_at AS bootstrappedAt,
              COUNT(*) AS total,
              SUM(CASE WHEN es.is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM subscriptions s
       JOIN entries e ON e.feed_id = s.feed_id
       JOIN entry_states es ON es.entry_id = e.id
       WHERE s.feed_id = ?`,
    )
      .bind(feedId)
      .first<{ bootstrappedAt: number | null; total: number; unread: number }>();
    expect(bootstrap?.bootstrappedAt).not.toBeNull();
    expect(bootstrap?.total).toBe(2);
    expect(bootstrap?.unread).toBe(0);

    const secondMessage = await claimDispatch(env.DB, feedId, now + 2);
    expect(secondMessage).not.toBeNull();
    if (secondMessage === null) throw new Error("expected second dispatch claim");

    await processRefreshMessage(
      env,
      secondMessage,
      now + 3,
      fakeFeed(rss(item("one", "One updated") + item("two", "Two") + item("three", "Three"))),
    );

    const state = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN es.is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM entries e
       JOIN entry_states es ON es.entry_id = e.id
       WHERE e.feed_id = ?`,
    )
      .bind(feedId)
      .first<{ total: number; unread: number }>();
    expect(state).toEqual({ total: 3, unread: 1 });

    const updated = await env.DB.prepare(
      "SELECT title FROM entries WHERE feed_id = ? AND source_id = 'one'",
    )
      .bind(feedId)
      .first<{ title: string }>();
    expect(updated?.title).toBe("One updated");

    expect(await processRefreshMessage(env, secondMessage, now + 4, fakeFeed(rss("")))).toBe(
      "stale",
    );
    const afterReplay = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM entries WHERE feed_id = ?",
    )
      .bind(feedId)
      .first<{ total: number }>();
    expect(afterReplay?.total).toBe(3);
  });

  it("does not establish bootstrap after a failed first fetch", async () => {
    const now = 1_800_100_000_000;
    const feedId = await ensureSubscription(env.DB, "https://failure.example/feed.xml", now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch claim");

    await expect(
      processRefreshMessage(env, message, now + 1, async () => new Response("no", { status: 503 })),
    ).rejects.toThrow("HTTP 503");

    const subscription = await env.DB.prepare(
      "SELECT bootstrapped_at AS bootstrappedAt FROM subscriptions WHERE feed_id = ?",
    )
      .bind(feedId)
      .first<{ bootstrappedAt: number | null }>();
    expect(subscription?.bootstrappedAt).toBeNull();
  });

  it("normalizes Atom entries through the same persistence path", async () => {
    const now = 1_800_200_000_000;
    const feedId = await ensureSubscription(env.DB, "https://atom.example/feed.xml", now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch claim");

    const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link href="https://atom.example/" rel="alternate" />
  <entry>
    <id>tag:example,2026:1</id>
    <title>Atom One</title>
    <link href="https://atom.example/one" rel="alternate" />
    <updated>2026-09-16T12:00:00Z</updated>
    <content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content>
  </entry>
</feed>`;

    await processRefreshMessage(env, message, now + 1, fakeFeed(atom));
    const row = await env.DB.prepare("SELECT title FROM entries WHERE feed_id = ?")
      .bind(feedId)
      .first<{ title: string }>();
    expect(row?.title).toBe("Atom One");
  });
});
