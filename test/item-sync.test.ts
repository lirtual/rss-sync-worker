import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { googleItemTag } from "../src/protocol";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerHeaders = { Authorization: "GoogleLogin auth=test-reader-token" };

const rss = (count: number) => {
  const items = Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return `<item>
      <guid>item-${id}</guid>
      <title>Item ${id}</title>
      <link>https://stream.example/${id}</link>
      <pubDate>Wed, 16 Sep 2026 12:${String(id).padStart(2, "0")}:00 GMT</pubDate>
      <description><![CDATA[<p>Body ${id}</p>]]></description>
    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Stream Feed</title><link>https://stream.example/</link>${items}</channel></rss>`;
};

const feedResponse = (body: string) => async (): Promise<Response> =>
  new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } });

const getIds = async (query: string) => {
  const params = new URLSearchParams(query);
  if (!params.has("s")) params.set("s", "user/-/state/com.google/reading-list");
  params.set("output", "json");
  const response = await exports.default.fetch(
    new Request(
      `https://rss-sync.test/api/reader/reader/api/0/stream/items/ids?${params.toString()}`,
      {
        headers: readerHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    itemRefs?: Array<{ id: string }>;
    continuation?: string;
    error?: string;
  };
  return { response, body };
};

describe("Reeder item synchronization", () => {
  it("uses stable keyset continuation while newer entries arrive", async () => {
    const now = 1_801_000_000_000;
    const feedId = await ensureSubscription(env.DB, "https://stream.example/feed.xml", now);
    const initial = await claimDispatch(env.DB, feedId, now);
    if (initial === null) throw new Error("expected initial dispatch");
    await processRefreshMessage(env, initial, now + 1, feedResponse(rss(5)));

    const first = await getIds("n=2");
    expect(first.response.status).toBe(200);
    expect(first.body.itemRefs).toHaveLength(2);
    expect(first.body.continuation).toBeTypeOf("string");
    const firstIds = first.body.itemRefs?.map((item) => item.id) ?? [];

    const next = await claimDispatch(env.DB, feedId, now + 2);
    if (next === null) throw new Error("expected second dispatch");
    await processRefreshMessage(env, next, now + 3, feedResponse(rss(6)));

    const second = await getIds(`n=2&c=${encodeURIComponent(first.body.continuation ?? "")}`);
    expect(second.response.status).toBe(200);
    const secondIds = second.body.itemRefs?.map((item) => item.id) ?? [];
    expect(secondIds).toHaveLength(2);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    const third = await getIds(`n=2&c=${encodeURIComponent(second.body.continuation ?? "")}`);
    const thirdIds = third.body.itemRefs?.map((item) => item.id) ?? [];
    expect(thirdIds).toHaveLength(1);
    expect(new Set([...firstIds, ...secondIds, ...thirdIds]).size).toBe(5);

    const newest = await getIds("n=10");
    expect(newest.body.itemRefs).toHaveLength(6);
  });

  it("retrieves contents for decimal and Google Reader long-form item ids", async () => {
    const now = 1_801_100_000_000;
    const feedId = await ensureSubscription(env.DB, "https://contents.example/feed.xml", now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");
    await processRefreshMessage(env, message, now + 1, feedResponse(rss(2)));

    const ids = await getIds(`s=feed/${feedId}&n=10`);
    const numericIds = ids.body.itemRefs?.map((item) => Number(item.id)) ?? [];
    expect(numericIds).toHaveLength(2);

    const form = new URLSearchParams();
    form.append("T", "test-reader-token");
    form.append("output", "json");
    form.append("i", String(numericIds[0]));
    form.append("i", googleItemTag(numericIds[1] ?? 0));
    const response = await exports.default.fetch(
      new Request("https://rss-sync.test/api/reader/reader/api/0/stream/items/contents", {
        method: "POST",
        headers: {
          ...readerHeaders,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ id: string; content: { content: string }; origin: { streamId: string } }>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.id).toMatch(/^tag:google\.com,2005:reader\/item\//u);
    expect(body.items[0]?.content.content).toContain("Body");
    expect(body.items[0]?.origin.streamId).toBe(`feed/${feedId}`);
  });

  it("rejects invalid continuation tokens explicitly", async () => {
    const result = await getIds("n=2&c=not-a-valid-token");
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe("BadContinuation");
  });
});
