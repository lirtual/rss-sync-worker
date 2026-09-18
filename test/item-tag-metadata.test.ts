import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const headers = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Metadata Feed</title><link>https://metadata.example/site</link>
<item><guid>metadata-1</guid><title>Metadata One</title><link>https://metadata.example/1</link></item>
</channel></rss>`;

const fetchReader = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      ...init,
      headers: { Authorization: headers.Authorization, ...(init?.headers ?? {}) },
    }),
  );

const edit = (values: Array<[string, string]>) =>
  fetchReader("subscription/edit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });

describe("Reeder item and tag metadata", () => {
  it("exposes feed site URL and current folder memberships on article items", async () => {
    const now = 1_802_100_000_000;
    const feedId = await ensureSubscription(env.DB, "https://metadata.example/feed.xml", now);
    const dispatch = await claimDispatch(env.DB, feedId, now);
    if (dispatch === null) throw new Error("expected dispatch");
    await processRefreshMessage(
      env,
      dispatch,
      now + 1,
      async () =>
        new Response(rss, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        }),
    );

    expect(
      (
        await edit([
          ["s", `feed/${feedId}`],
          ["a", "user/-/label/Engineering"],
          ["a", "user/1/label/Reading"],
        ])
      ).status,
    ).toBe(200);

    const response = await fetchReader(
      `stream/contents/${encodeURIComponent(`feed/${feedId}`)}?n=10`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        origin: { streamId: string; title: string; htmlUrl?: string };
        categories: string[];
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.origin).toEqual({
      streamId: `feed/${feedId}`,
      title: "Metadata Feed",
      htmlUrl: "https://metadata.example/site",
    });
    expect(body.items[0]?.categories).toEqual(
      expect.arrayContaining([
        "user/-/state/com.google/reading-list",
        "user/-/state/com.google/read",
        "user/-/label/Engineering",
        "user/-/label/Reading",
      ]),
    );

    expect(
      (
        await edit([
          ["s", `feed/${feedId}`],
          ["r", "user/-/label/Reading"],
        ])
      ).status,
    ).toBe(200);

    const updated = await fetchReader(
      `stream/contents/${encodeURIComponent(`feed/${feedId}`)}?n=10`,
    );
    const updatedBody = (await updated.json()) as { items: Array<{ categories: string[] }> };
    expect(updatedBody.items[0]?.categories).toContain("user/-/label/Engineering");
    expect(updatedBody.items[0]?.categories).not.toContain("user/-/label/Reading");
  });

  it("returns starred plus complete folder metadata from tag/list", async () => {
    const now = Date.now();
    const feedId = await ensureSubscription(env.DB, "https://tag-meta.example/feed.xml", now);
    await edit([
      ["s", `feed/${feedId}`],
      ["a", "user/-/label/Alpha"],
      ["a", "user/-/label/Beta"],
    ]);

    const response = await fetchReader("tag/list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tags: Array<{ id: string; label?: string; type?: string }>;
    };
    expect(body.tags).toEqual(
      expect.arrayContaining([
        { id: "user/-/state/com.google/starred" },
        { id: "user/-/label/Alpha", label: "Alpha", type: "folder" },
        { id: "user/-/label/Beta", label: "Beta", type: "folder" },
      ]),
    );
  });
});
