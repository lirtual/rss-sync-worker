import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const adminHeaders = {
  Authorization: "Bearer test-reader-token",
  "content-type": "text/xml; charset=UTF-8",
};

const representativeOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Representative subscriptions</title></head>
  <body>
    <outline text="Engineering" title="Engineering">
      <outline type="rss" text="Shared Feed" title="Shared Feed" xmlUrl="https://shared-opml.example/feed.xml" />
      <outline type="rss" text="Engineering Only" title="Engineering Only" xmlUrl="https://engineering-opml.example/feed.xml" />
    </outline>
    <outline text="Reading" title="Reading">
      <outline type="rss" text="Shared Feed" title="Shared Feed" xmlUrl="https://shared-opml.example/feed.xml" />
    </outline>
    <outline type="rss" text="Unfiled Feed" title="Unfiled Feed" xmlUrl="https://unfiled-opml.example/feed.xml" />
  </body>
</opml>`;

const importOpml = (xml: string) =>
  exports.default.fetch(
    new Request("https://rss-sync.test/admin/opml/import", {
      method: "POST",
      headers: adminHeaders,
      body: xml,
    }),
  );

const exportOpml = () =>
  exports.default.fetch(
    new Request("https://rss-sync.test/admin/opml/export", {
      headers: { Authorization: adminHeaders.Authorization },
    }),
  );

const structure = async () => {
  const subscriptions = await env.DB.prepare(
    `SELECT f.canonical_feed_url AS url, s.custom_title AS title
     FROM subscriptions s
     JOIN feeds f ON f.id = s.feed_id
     WHERE s.active = 1
       AND f.canonical_feed_url LIKE '%-opml.example/%'
     ORDER BY f.canonical_feed_url`,
  ).all<{ url: string; title: string | null }>();

  const memberships = await env.DB.prepare(
    `SELECT f.canonical_feed_url AS url, folder.name AS folder
     FROM subscription_folders sf
     JOIN subscriptions s ON s.feed_id = sf.feed_id AND s.active = 1
     JOIN feeds f ON f.id = sf.feed_id
     JOIN folders folder ON folder.id = sf.folder_id
     WHERE f.canonical_feed_url LIKE '%-opml.example/%'
     ORDER BY f.canonical_feed_url, folder.name`,
  ).all<{ url: string; folder: string }>();

  return {
    subscriptions: subscriptions.results,
    memberships: memberships.results,
  };
};

describe("OPML portability", () => {
  it("imports idempotently, preserves multi-folder structure, and round-trips through export", async () => {
    const first = await importOpml(representativeOpml);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ feeds: 3, folders: 2, enqueued: 3 });

    const expected = {
      subscriptions: [
        { url: "https://engineering-opml.example/feed.xml", title: "Engineering Only" },
        { url: "https://shared-opml.example/feed.xml", title: "Shared Feed" },
        { url: "https://unfiled-opml.example/feed.xml", title: "Unfiled Feed" },
      ],
      memberships: [
        { url: "https://engineering-opml.example/feed.xml", folder: "Engineering" },
        { url: "https://shared-opml.example/feed.xml", folder: "Engineering" },
        { url: "https://shared-opml.example/feed.xml", folder: "Reading" },
      ],
    };
    expect(await structure()).toEqual(expected);

    const duplicate = await importOpml(representativeOpml);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as { feeds: number }).toMatchObject({ feeds: 3 });
    expect(await structure()).toEqual(expected);

    const exportedResponse = await exportOpml();
    expect(exportedResponse.status).toBe(200);
    expect(exportedResponse.headers.get("content-type")).toContain("text/x-opml");
    const exported = await exportedResponse.text();
    expect(exported).toContain("https://shared-opml.example/feed.xml");
    expect(exported).toContain("Engineering");
    expect(exported).toContain("Reading");
    expect(exported).not.toContain("test-admin-token");
    expect(exported).not.toContain("test-reader-token");
    expect(exported).not.toContain("is_read");
    expect(exported).not.toContain("is_starred");

    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM subscription_folders
         WHERE feed_id IN (
           SELECT id FROM feeds WHERE canonical_feed_url LIKE '%-opml.example/%'
         )`,
      ),
      env.DB.prepare(
        `DELETE FROM subscriptions
         WHERE feed_id IN (
           SELECT id FROM feeds WHERE canonical_feed_url LIKE '%-opml.example/%'
         )`,
      ),
      env.DB.prepare(
        `DELETE FROM folders
         WHERE NOT EXISTS (
           SELECT 1 FROM subscription_folders sf WHERE sf.folder_id = folders.id
         )`,
      ),
    ]);
    expect((await structure()).subscriptions).toHaveLength(0);

    const restored = await importOpml(exported);
    expect(restored.status).toBe(200);
    expect((await restored.json()) as { feeds: number }).toMatchObject({ feeds: 3 });
    expect(await structure()).toEqual(expected);
  });

  it("rejects oversized and entity-bearing OPML before persistence", async () => {
    const entityDocument = `<?xml version="1.0"?><!DOCTYPE opml [<!ENTITY x "bad">]><opml version="2.0"><body /></opml>`;
    const entityResponse = await importOpml(entityDocument);
    expect(entityResponse.status).toBe(400);

    const oversized = `<opml version="2.0"><body>${"x".repeat(1024 * 1024)}</body></opml>`;
    const oversizedResponse = await importOpml(oversized);
    expect(oversizedResponse.status).toBe(413);
  });
});
