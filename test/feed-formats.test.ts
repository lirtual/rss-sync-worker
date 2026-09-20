import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/feed/parser";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerRoot = "https://rss-sync.test/api/reader/reader/api/0";
const readerHeaders = { Authorization: "GoogleLogin auth=test-reader-token" };

const formats = [
  {
    key: "rss2",
    body: `<?xml version="1.0"?>
<rss version="2.0"><channel><title>RSS 2</title><link>https://rss2.example/</link>
<item><guid>rss2-one</guid><title>RSS 2 Item</title><link>https://rss2.example/one</link><description><![CDATA[<p>RSS 2 body</p>]]></description></item>
</channel></rss>`,
    title: "RSS 2 Item",
    bodyText: "RSS 2 body",
  },
  {
    key: "rdf",
    body: `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://rdf.example/feed"><title>RSS 1</title><link>https://rdf.example/</link></channel>
<item rdf:about="https://rdf.example/one"><title>RSS 1 Item</title><link>https://rdf.example/one</link><dc:date>2026-09-19T00:00:00Z</dc:date><description>RSS 1 body</description></item>
</rdf:RDF>`,
    title: "RSS 1 Item",
    bodyText: "RSS 1 body",
  },
  {
    key: "atom1",
    body: `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 1</title><link rel="alternate" href="https://atom1.example/"/>
<entry><id>tag:atom1,1</id><title>Atom 1 Item</title><link href="https://atom1.example/one"/><updated>2026-09-19T00:00:00Z</updated><content>Atom 1 body</content></entry>
</feed>`,
    title: "Atom 1 Item",
    bodyText: "Atom 1 body",
  },
  {
    key: "atom03",
    body: `<?xml version="1.0"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Atom 0.3</title><link rel="alternate" href="https://atom03.example/"/>
<entry><id>tag:atom03,1</id><title>Atom 0.3 Item</title><link href="https://atom03.example/one"/><issued>2026-09-19T00:00:00Z</issued><modified>2026-09-19T00:01:00Z</modified><content>Atom 0.3 body</content></entry>
</feed>`,
    title: "Atom 0.3 Item",
    bodyText: "Atom 0.3 body",
  },
  {
    key: "json1",
    body: JSON.stringify({
      version: "https://jsonfeed.org/version/1",
      title: "JSON Feed 1",
      home_page_url: "https://json1.example/",
      items: [
        {
          id: "json1-one",
          url: "https://json1.example/one",
          title: "JSON 1 Item",
          content_text: "JSON 1 body",
          date_published: "2026-09-19T00:00:00Z",
        },
      ],
    }),
    title: "JSON 1 Item",
    bodyText: "JSON 1 body",
  },
  {
    key: "json11",
    body: JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JSON Feed 1.1",
      home_page_url: "https://json11.example/",
      items: [
        {
          id: "json11-one",
          url: "https://json11.example/one",
          title: "JSON 1.1 Item",
          content_html: "<p>JSON 1.1 body</p>",
          date_modified: "2026-09-19T00:01:00Z",
        },
      ],
    }),
    title: "JSON 1.1 Item",
    bodyText: "JSON 1.1 body",
  },
] as const;

const refreshAndRead = async (
  key: string,
  body: string,
): Promise<{ title: string; content: string }> => {
  const now = 1_840_000_000_000 + key.length * 100_000;
  const feedId = await ensureSubscription(env.DB, `https://${key}.example/feed`, now);
  const message = await claimDispatch(env.DB, feedId, now);
  if (message === null) throw new Error("expected dispatch");
  const outcome = await processRefreshMessage(
    env,
    message,
    now + 1,
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  );
  expect(outcome).toBe("processed");

  const row = await env.DB.prepare("SELECT id FROM entries WHERE feed_id = ? ORDER BY id LIMIT 1")
    .bind(feedId)
    .first<{ id: number }>();
  if (row === null) throw new Error("expected persisted entry");

  const form = new URLSearchParams({
    T: "test-reader-token",
    output: "json",
    i: String(row.id),
  });
  const response = await exports.default.fetch(
    new Request(`${readerRoot}/stream/items/contents`, {
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
    items: Array<{ title: string; content: { content: string } }>;
  };
  const item = payload.items[0];
  if (item === undefined) throw new Error("expected Reader item");
  return { title: item.title, content: item.content.content };
};

describe("feed format baseline", () => {
  for (const fixture of formats) {
    it(`persists and serves ${fixture.key} through the Reader surface`, async () => {
      const item = await refreshAndRead(fixture.key, fixture.body);
      expect(item.title).toBe(fixture.title);
      expect(item.content).toContain(fixture.bodyText);
    });
  }

  it("normalizes icon and enclosure candidates for downstream tickets", () => {
    const rss =
      parseFeed(`<rss version="2.0"><channel><title>Media</title><link>https://media.example/</link>
<image><url>https://media.example/icon.png</url></image>
<item><guid>one</guid><title>One</title><enclosure url="https://media.example/a.mp3" type="audio/mpeg" length="42"/></item>
</channel></rss>`);
    expect(rss.iconUrls).toEqual(["https://media.example/icon.png"]);
    expect(rss.entries[0]?.enclosures).toEqual([
      {
        url: "https://media.example/a.mp3",
        mimeType: "audio/mpeg",
        lengthBytes: 42,
        title: null,
      },
    ]);

    const atom =
      parseFeed(`<feed><title>Atom Media</title><icon>https://atom-media.example/icon.png</icon>
<entry><id>one</id><title>One</title><link rel="enclosure" href="https://atom-media.example/a.mp4" type="video/mp4"/></entry>
</feed>`);
    expect(atom.iconUrls).toEqual(["https://atom-media.example/icon.png"]);
    expect(atom.entries[0]?.enclosures[0]).toMatchObject({
      url: "https://atom-media.example/a.mp4",
      mimeType: "video/mp4",
    });

    const json = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON Media",
        icon: "https://json-media.example/icon.png",
        favicon: "https://json-media.example/favicon.ico",
        items: [
          {
            id: "one",
            content_text: "one",
            attachments: [
              {
                url: "https://json-media.example/a.mp3",
                mime_type: "audio/mpeg",
                size_in_bytes: 7,
                title: "Audio",
              },
            ],
          },
        ],
      }),
    );
    expect(json.iconUrls).toEqual([
      "https://json-media.example/icon.png",
      "https://json-media.example/favicon.ico",
    ]);
    expect(json.entries[0]?.enclosures[0]).toEqual({
      url: "https://json-media.example/a.mp3",
      mimeType: "audio/mpeg",
      lengthBytes: 7,
      title: "Audio",
    });
  });
});
