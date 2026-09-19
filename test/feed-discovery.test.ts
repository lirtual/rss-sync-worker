import { describe, expect, it } from "vitest";
import { discoverFeed } from "../src/feed/discovery";
import type { FeedFetchError } from "../src/feed/fetch";

const response = (body: string, contentType: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });

describe("feed discovery", () => {
  it("accepts a direct supported feed and keeps the final URL", async () => {
    const fetcher = (async () =>
      response(
        '<rss version="2.0"><channel><title>Direct</title><link>https://direct.example/</link></channel></rss>',
        "application/rss+xml",
      )) as typeof fetch;

    await expect(discoverFeed("https://direct.example/feed.xml", fetcher)).resolves.toEqual({
      feedUrl: "https://direct.example/feed.xml",
      title: "Direct",
    });
  });

  it("discovers a relative advertised feed and skips an earlier invalid candidate", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      seen.push(url);
      if (url === "https://site.example/") {
        return response(
          `<!doctype html><html><head>
<link rel="alternate" type="application/rss+xml" href="/broken.xml">
<link rel="alternate stylesheet" type="application/atom+xml" href="/feed.atom">
</head></html>`,
          "text/html; charset=utf-8",
        );
      }
      if (url === "https://site.example/broken.xml") {
        return response("<not-a-feed/>", "application/xml");
      }
      if (url === "https://site.example/feed.atom") {
        return response(
          '<feed><title>Discovered</title><link href="https://site.example/"/></feed>',
          "application/atom+xml",
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    await expect(discoverFeed("https://site.example/", fetcher)).resolves.toEqual({
      feedUrl: "https://site.example/feed.atom",
      title: "Discovered",
    });
    expect(seen).toEqual([
      "https://site.example/",
      "https://site.example/broken.xml",
      "https://site.example/feed.atom",
    ]);
  });

  it("returns null when an HTML page advertises no supported feed", async () => {
    const fetcher = (async () =>
      response("<html><head><title>No feed</title></head></html>", "text/html")) as typeof fetch;
    await expect(discoverFeed("https://none.example/", fetcher)).resolves.toBeNull();
  });

  it("rejects private advertised feed targets without fetching them", async () => {
    const fetcher = (async () =>
      response(
        '<html><head><link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed.xml"></head></html>',
        "text/html",
      )) as typeof fetch;

    await expect(discoverFeed("https://unsafe.example/", fetcher)).rejects.toMatchObject<
      Partial<FeedFetchError>
    >({
      code: "unsafe_target",
    });
  });

  it("rejects discovery HTML larger than one MiB", async () => {
    const html = `<html><head></head><body>${"x".repeat(1024 * 1024)}</body></html>`;
    const fetcher = (async () => response(html, "text/html")) as typeof fetch;

    await expect(discoverFeed("https://large-html.example/", fetcher)).rejects.toMatchObject<
      Partial<FeedFetchError>
    >({
      code: "response_too_large",
    });
  });
});
