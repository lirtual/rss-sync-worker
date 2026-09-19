import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { refreshFeedIcon } from "../src/feed/icon";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerHeaders = { Authorization: "GoogleLogin auth=test-reader-token" };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const subscription = async (feedId: number) => {
  const response = await exports.default.fetch(
    new Request("https://rss-sync.test/api/reader/reader/api/0/subscription/list?output=json", {
      headers: readerHeaders,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    subscriptions: Array<{ id: string; iconUrl: string }>;
  };
  return body.subscriptions.find((item) => item.id === `feed/${feedId}`);
};

describe("feed icon delivery", () => {
  it("prefers a feed-declared icon and serves bytes with cache validators", async () => {
    const now = 1_870_000_000_000;
    const feedUrl = "https://declared-icon.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, feedUrl, now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");

    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      seen.push(url);
      if (url === feedUrl) {
        return new Response(
          `<rss version="2.0"><channel><title>Declared Icon</title><link>https://declared-icon.example/</link>
<image><url>/declared.png</url></image></channel></rss>`,
          { status: 200, headers: { "content-type": "application/rss+xml" } },
        );
      }
      if (url === "https://declared-icon.example/declared.png") {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    expect(await processRefreshMessage(env, message, now + 1, fetcher)).toBe("processed");
    expect(seen).toEqual([feedUrl, "https://declared-icon.example/declared.png"]);

    const row = await subscription(feedId);
    expect(row?.iconUrl).toMatch(/^https:\/\/rss-sync\.test\/feed-icon\/[0-9a-f-]+$/u);
    const iconUrl = row?.iconUrl;
    if (iconUrl === undefined || iconUrl === "") throw new Error("expected icon URL");

    const icon = await exports.default.fetch(new Request(iconUrl));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/u);
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(icon.headers.get("cache-control")).toContain("max-age=");
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(png);

    const notModified = await exports.default.fetch(
      new Request(iconUrl, { headers: { "If-None-Match": icon.headers.get("etag") ?? "" } }),
    );
    expect(notModified.status).toBe(304);
  });

  it("discovers HTML icons before falling back to origin favicon", async () => {
    const now = 1_870_100_000_000;
    const feedUrl = "https://html-icon.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, feedUrl, now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");

    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      seen.push(url);
      if (url === feedUrl) {
        return new Response(
          '<rss version="2.0"><channel><title>HTML Icon</title><link>https://html-icon.example/</link></channel></rss>',
          { status: 200 },
        );
      }
      if (url === "https://html-icon.example/") {
        return new Response(
          '<html><head><link rel="apple-touch-icon" href="/apple.png"></head></html>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://html-icon.example/apple.png") {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    expect(await processRefreshMessage(env, message, now + 1, fetcher)).toBe("processed");
    expect(seen).toEqual([
      feedUrl,
      "https://html-icon.example/",
      "https://html-icon.example/apple.png",
    ]);
    expect((await subscription(feedId))?.iconUrl).not.toBe("");
  });

  it("uses /favicon.ico fallback and negatively caches missing icons", async () => {
    const now = 1_870_200_000_000;
    const fallbackId = await ensureSubscription(
      env.DB,
      "https://favicon-fallback.example/feed.xml",
      now,
    );
    const fallbackMessage = await claimDispatch(env.DB, fallbackId, now);
    if (fallbackMessage === null) throw new Error("expected dispatch");

    const fallbackFetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://favicon-fallback.example/feed.xml") {
        return new Response(
          '<rss version="2.0"><channel><title>Fallback</title><link>https://favicon-fallback.example/</link></channel></rss>',
          { status: 200 },
        );
      }
      if (url === "https://favicon-fallback.example/") {
        return new Response("<html><head></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://favicon-fallback.example/favicon.ico") {
        return new Response(png, {
          status: 200,
          headers: { "content-type": "image/vnd.microsoft.icon" },
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    expect(await processRefreshMessage(env, fallbackMessage, now + 1, fallbackFetcher)).toBe(
      "processed",
    );
    expect((await subscription(fallbackId))?.iconUrl).not.toBe("");

    const missingId = await ensureSubscription(env.DB, "https://missing-icon.example/feed.xml", now);
    let calls = 0;
    const missingFetcher = (async () => {
      calls += 1;
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const parsed = {
      title: "Missing",
      siteUrl: "https://missing-icon.example/",
      iconUrls: [],
      entries: [],
    };
    await refreshFeedIcon(env.DB, missingId, parsed, "https://missing-icon.example/feed.xml", now, missingFetcher);
    const firstCalls = calls;
    expect(firstCalls).toBeGreaterThan(0);
    await refreshFeedIcon(
      env.DB,
      missingId,
      parsed,
      "https://missing-icon.example/feed.xml",
      now + 60_000,
      missingFetcher,
    );
    expect(calls).toBe(firstCalls);
    expect((await subscription(missingId))?.iconUrl).toBe("");
  });

  it("rejects oversized and unsafe icon candidates without failing feed refresh", async () => {
    const now = 1_870_300_000_000;
    const feedUrl = "https://unsafe-icon.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, feedUrl, now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");

    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === feedUrl) {
        return new Response(
          `<rss version="2.0"><channel><title>Unsafe</title><link>https://unsafe-icon.example/</link>
<image><url>http://127.0.0.1/private.png</url></image></channel></rss>`,
          { status: 200 },
        );
      }
      if (url === "https://unsafe-icon.example/") {
        return new Response(
          '<html><head><link rel="icon" href="/huge.png"></head></html>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://unsafe-icon.example/huge.png") {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(256 * 1024 + 1) },
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    expect(await processRefreshMessage(env, message, now + 1, fetcher)).toBe("processed");
    expect((await subscription(feedId))?.iconUrl).toBe("");
  });

  it("returns 404 for unknown public icon IDs", async () => {
    const response = await exports.default.fetch(
      new Request("https://rss-sync.test/feed-icon/not-a-real-icon"),
    );
    expect(response.status).toBe(404);
  });
});
