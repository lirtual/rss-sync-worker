import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerHeaders = { Authorization: "GoogleLogin auth=test-reader-token" };

const refresh = async (
  key: string,
  body: string,
  now: number,
): Promise<{ feedId: number; entryId: number }> => {
  const feedId = await ensureSubscription(env.DB, `https://${key}.example/feed`, now);
  const message = await claimDispatch(env.DB, feedId, now);
  if (message === null) throw new Error("expected dispatch");
  expect(
    await processRefreshMessage(
      env,
      message,
      now + 1,
      async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
    ),
  ).toBe("processed");
  const entry = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ? ORDER BY id LIMIT 1")
    .bind(feedId)
    .first<{ id: number }>();
  if (entry === null) throw new Error("expected entry");
  return { feedId, entryId: entry.id };
};

const readerItem = async (entryId: number) => {
  const form = new URLSearchParams({
    T: "test-reader-token",
    output: "json",
    i: String(entryId),
  });
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
  const payload = (await response.json()) as {
    items: Array<{ enclosure: Array<{ url: string; type?: string }> }>;
  };
  const item = payload.items[0];
  if (item === undefined) throw new Error("expected Reader item");
  return item;
};

describe("entry enclosures", () => {
  it("persists RSS enclosures in source order and drops unsafe URLs", async () => {
    const now = 1_850_000_000_000;
    const { entryId } = await refresh(
      "rss-enclosures",
      `<rss version="2.0"><channel><title>Podcast</title><link>https://rss-enclosures.example/</link>
<item><guid>episode-1</guid><title>Episode</title><link>https://rss-enclosures.example/episodes/1</link>
<enclosure url="/media/a.mp3" type="audio/mpeg" length="42"/>
<enclosure url="javascript:alert(1)" type="text/html"/>
<enclosure url="https://cdn.example/video.mp4" type="video/mp4" length="84"/>
</item></channel></rss>`,
      now,
    );

    expect((await readerItem(entryId)).enclosure).toEqual([
      { url: "https://rss-enclosures.example/media/a.mp3", type: "audio/mpeg" },
      { url: "https://cdn.example/video.mp4", type: "video/mp4" },
    ]);
  });

  it("persists Atom and JSON Feed enclosure metadata", async () => {
    const atom = await refresh(
      "atom-enclosures",
      `<feed><title>Atom Media</title><entry><id>atom-one</id><title>Atom</title>
<link rel="alternate" href="https://atom-enclosures.example/one"/>
<link rel="enclosure" href="https://atom-enclosures.example/audio.m4a" type="audio/mp4"/>
</entry></feed>`,
      1_850_100_000_000,
    );
    expect((await readerItem(atom.entryId)).enclosure).toEqual([
      { url: "https://atom-enclosures.example/audio.m4a", type: "audio/mp4" },
    ]);

    const json = await refresh(
      "json-enclosures",
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON Media",
        items: [
          {
            id: "json-one",
            title: "JSON",
            content_text: "body",
            attachments: [
              {
                url: "https://json-enclosures.example/audio.mp3",
                mime_type: "audio/mpeg",
                size_in_bytes: 99,
                title: "Audio",
              },
            ],
          },
        ],
      }),
      1_850_200_000_000,
    );
    expect((await readerItem(json.entryId)).enclosure).toEqual([
      { url: "https://json-enclosures.example/audio.mp3", type: "audio/mpeg" },
    ]);
  });

  it("replaces observed enclosure sets idempotently without changing Reader State", async () => {
    const now = 1_850_300_000_000;
    const first = await refresh(
      "replace-enclosures",
      `<rss version="2.0"><channel><title>Replace</title><link>https://replace-enclosures.example/</link>
<item><guid>same</guid><title>Same</title><enclosure url="https://replace-enclosures.example/old.mp3" type="audio/mpeg"/></item>
</channel></rss>`,
      now,
    );
    await env.DB.prepare(
      "UPDATE entry_states SET is_read = 0, is_starred = 1, updated_at = ? WHERE entry_id = ?",
    )
      .bind(now + 2, first.entryId)
      .run();

    const message = await claimDispatch(env.DB, first.feedId, now + 3);
    if (message === null) throw new Error("expected second dispatch");
    await processRefreshMessage(
      env,
      message,
      now + 4,
      async () =>
        new Response(
          `<rss version="2.0"><channel><title>Replace</title><link>https://replace-enclosures.example/</link>
<item><guid>same</guid><title>Same</title><enclosure url="https://replace-enclosures.example/new.mp3" type="audio/mpeg"/></item>
</channel></rss>`,
          { status: 200 },
        ),
    );

    expect((await readerItem(first.entryId)).enclosure).toEqual([
      { url: "https://replace-enclosures.example/new.mp3", type: "audio/mpeg" },
    ]);
    const state = await env.DB.prepare(
      "SELECT is_read AS isRead, is_starred AS isStarred FROM entry_states WHERE entry_id = ?",
    )
      .bind(first.entryId)
      .first<{ isRead: number; isStarred: number }>();
    expect(state).toEqual({ isRead: 0, isStarred: 1 });
  });

  it("always emits an empty enclosure array when an entry has none", async () => {
    const plain = await refresh(
      "no-enclosures",
      `<rss version="2.0"><channel><title>Plain</title><link>https://no-enclosures.example/</link>
<item><guid>plain</guid><title>Plain</title></item></channel></rss>`,
      1_850_400_000_000,
    );
    expect((await readerItem(plain.entryId)).enclosure).toEqual([]);
  });
});
