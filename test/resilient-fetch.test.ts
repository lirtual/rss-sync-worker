import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { assertSafeFeedUrl, fetchFeedDocument } from "../src/feed/fetch";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const rss = (guid: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title><link>https://example.com/</link>
<item><guid>${guid}</guid><title>${guid}</title><link>https://example.com/${guid}</link></item>
</channel></rss>`;

const ok = (body: string, headers: HeadersInit = {}): Response =>
  new Response(body, { status: 200, headers });

describe("safe feed retrieval", () => {
  it("rejects obvious private and metadata targets before fetch", () => {
    for (const value of [
      "http://127.0.0.1/feed",
      "http://10.0.0.1/feed",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://[::1]/feed",
    ]) {
      expect(() => assertSafeFeedUrl(value)).toThrow("not publicly routable");
    }
  });

  it("sends conditional headers and handles 304 without reading a body", async () => {
    let seen: Headers | null = null;
    const result = await fetchFeedDocument(
      "https://conditional.example/feed.xml",
      { etag: '"v1"', lastModified: "Wed, 16 Sep 2026 12:00:00 GMT" },
      async (_input, init) => {
        seen = new Headers(init?.headers);
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      },
    );
    expect(result.status).toBe("not-modified");
    expect(seen?.get("If-None-Match")).toBe('"v1"');
    expect(seen?.get("If-Modified-Since")).toBe("Wed, 16 Sep 2026 12:00:00 GMT");
  });

  it("rejects redirects into private targets", async () => {
    await expect(
      fetchFeedDocument(
        "https://redirect.example/feed.xml",
        { etag: null, lastModified: null },
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
          }),
      ),
    ).rejects.toThrow("not publicly routable");
  });
});

describe("refresh recovery and redirect persistence", () => {
  it("records failure with backoff without deleting the subscription", async () => {
    const now = 1_820_000_000_000;
    const feedId = await ensureSubscription(
      env.DB,
      "https://failure-resilient.example/feed.xml",
      now,
    );
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");

    expect(
      await processRefreshMessage(
        env,
        message,
        now + 1,
        async () => new Response("unavailable", { status: 503 }),
      ),
    ).toBe("failed");

    const row = await env.DB.prepare(
      `SELECT s.active,
              f.consecutive_failures AS failures,
              f.last_error_message AS errorMessage,
              f.next_fetch_at AS nextFetchAt,
              f.dispatch_token AS dispatchToken
       FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
       WHERE f.id = ?`,
    )
      .bind(feedId)
      .first<{
        active: number;
        failures: number;
        errorMessage: string | null;
        nextFetchAt: number;
        dispatchToken: string | null;
      }>();
    expect(row?.active).toBe(1);
    expect(row?.failures).toBe(1);
    expect(row?.errorMessage).toContain("HTTP 503");
    expect(row?.nextFetchAt).toBe(now + 1 + 15 * 60 * 1000);
    expect(row?.dispatchToken).toBeNull();
  });

  it("treats duplicate delivery as stale after a successful commit", async () => {
    const now = 1_820_100_000_000;
    const feedId = await ensureSubscription(env.DB, "https://duplicate.example/feed.xml", now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");

    expect(await processRefreshMessage(env, message, now + 1, async () => ok(rss("one")))).toBe(
      "processed",
    );
    expect(await processRefreshMessage(env, message, now + 2, async () => ok(rss("one")))).toBe(
      "stale",
    );
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM entries WHERE feed_id = ?")
      .bind(feedId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("migrates canonical URL only after three stable permanent redirect successes", async () => {
    const now = 1_820_200_000_000;
    const oldUrl = "https://old-redirect.example/feed.xml";
    const newUrl = "https://new-redirect.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, oldUrl, now);

    const redirectFetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = input.toString();
      if (url === oldUrl) return new Response(null, { status: 301, headers: { location: newUrl } });
      return ok(rss("redirected"));
    };

    for (let index = 0; index < 2; index += 1) {
      const message = await claimDispatch(env.DB, feedId, now + index * 10 + 1);
      if (message === null) throw new Error("expected dispatch");
      expect(await processRefreshMessage(env, message, now + index * 10 + 2, redirectFetcher)).toBe(
        "processed",
      );
      const before = await env.DB.prepare(
        "SELECT canonical_feed_url AS url FROM feeds WHERE id = ?",
      )
        .bind(feedId)
        .first<{ url: string }>();
      expect(before?.url).toBe(oldUrl);
    }

    const third = await claimDispatch(env.DB, feedId, now + 30);
    if (third === null) throw new Error("expected third dispatch");
    expect(await processRefreshMessage(env, third, now + 31, redirectFetcher)).toBe("processed");

    const migrated = await env.DB.prepare(
      "SELECT canonical_feed_url AS url FROM feeds WHERE id = ?",
    )
      .bind(feedId)
      .first<{ url: string }>();
    expect(migrated?.url).toBe(newUrl);

    const alias = await env.DB.prepare(
      "SELECT feed_id AS feedId FROM feed_url_aliases WHERE url = ?",
    )
      .bind(oldUrl)
      .first<{ feedId: number }>();
    expect(alias?.feedId).toBe(feedId);
    expect(await ensureSubscription(env.DB, oldUrl, now + 40)).toBe(feedId);
  });

  it("does not delete local history when a source drops old items", async () => {
    const now = 1_820_300_000_000;
    const feedId = await ensureSubscription(env.DB, "https://window.example/feed.xml", now);
    const first = await claimDispatch(env.DB, feedId, now);
    if (first === null) throw new Error("expected dispatch");
    await processRefreshMessage(env, first, now + 1, async () =>
      ok(
        rss("one").replace(
          "</channel>",
          `<item><guid>two</guid><title>two</title></item></channel>`,
        ),
      ),
    );

    const second = await claimDispatch(env.DB, feedId, now + 2);
    if (second === null) throw new Error("expected second dispatch");
    await processRefreshMessage(env, second, now + 3, async () => ok(rss("two")));

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM entries WHERE feed_id = ?")
      .bind(feedId)
      .first<{ count: number }>();
    expect(count?.count).toBe(2);
  });
});
