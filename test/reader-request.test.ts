import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";

const fetchReader = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${root}/${path}`, init));

const authHeaders = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const twoItemFeed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Normalize Feed</title><link>https://normalize.example/</link>
<item><guid>normalize-1</guid><title>One</title><link>https://normalize.example/1</link></item>
<item><guid>normalize-2</guid><title>Two</title><link>https://normalize.example/2</link></item>
</channel></rss>`;

describe("Reader request normalization", () => {
  it("returns 401 for invalid Reader credentials", async () => {
    const response = await fetchReader("token", {
      headers: { Authorization: "GoogleLogin auth=wrong-token" },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Error=InvalidAuthToken\n");
  });

  it("accepts the real edit token without Authorization and rejects a placeholder alone", async () => {
    const feedId = await ensureSubscription(env.DB, "https://token-auth.example/feed.xml", Date.now());

    const authorized = await fetchReader(
      `subscription/edit?T=test-reader-token&a=${encodeURIComponent("user/1/label/Query")}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
          ["s", `feed/${feedId}`],
          ["ac", "edit"],
          ["a", "user/-/label/Body"],
        ]),
      },
    );
    expect(authorized.status).toBe(200);

    const placeholder = await fetchReader("subscription/edit?T=x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["s", `feed/${feedId}`],
        ["ac", "edit"],
        ["t", "must-not-apply"],
      ]),
    });
    expect(placeholder.status).toBe(401);

    const folders = await env.DB.prepare(
      `SELECT folder.name AS name
       FROM folders folder
       JOIN subscription_folders sf ON sf.folder_id = folder.id
       WHERE sf.feed_id = ?
       ORDER BY folder.name`,
    )
      .bind(feedId)
      .all<{ name: string }>();
    expect(folders.results.map((row) => row.name)).toEqual(["Body", "Query"]);
  });

  it("lets form singleton values override query values while valid auth tolerates T=x", async () => {
    const feedId = await ensureSubscription(env.DB, "https://override.example/feed.xml", Date.now());

    const response = await fetchReader(
      `subscription/edit?T=x&s=feed%2F${feedId}&ac=unsubscribe&t=QueryTitle`,
      {
        method: "POST",
        headers: authHeaders,
        body: new URLSearchParams([
          ["s", `feed/${feedId}`],
          ["ac", "edit"],
          ["t", "BodyTitle"],
        ]),
      },
    );
    expect(response.status).toBe(200);

    const state = await env.DB.prepare(
      "SELECT active, custom_title AS customTitle FROM subscriptions WHERE feed_id = ?",
    )
      .bind(feedId)
      .first<{ active: number; customTitle: string | null }>();
    expect(state).toEqual({ active: 1, customTitle: "BodyTitle" });
  });

  it("preserves repeated item ids across query and form and emits canonical user streams", async () => {
    const now = 1_801_600_000_000;
    const feedId = await ensureSubscription(env.DB, "https://normalize.example/feed.xml", now);
    const dispatch = await claimDispatch(env.DB, feedId, now);
    if (dispatch === null) throw new Error("expected dispatch");
    await processRefreshMessage(
      env,
      dispatch,
      now + 1,
      async () =>
        new Response(twoItemFeed, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        }),
    );

    const idsResponse = await fetchReader(
      `stream/items/ids?s=${encodeURIComponent("user/1/state/com.google/reading-list")}&n=10`,
      { headers: { Authorization: authHeaders.Authorization } },
    );
    expect(idsResponse.status).toBe(200);
    const ids = (await idsResponse.json()) as { itemRefs: Array<{ id: string }> };
    expect(ids.itemRefs).toHaveLength(2);

    const response = await fetchReader(
      `stream/items/contents?i=${encodeURIComponent(ids.itemRefs[0]?.id ?? "")}`,
      {
        method: "POST",
        headers: authHeaders,
        body: new URLSearchParams([["i", ids.itemRefs[1]?.id ?? ""]]),
      },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: Array<{ categories: string[] }>;
    };
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(item.categories).toContain("user/-/state/com.google/reading-list");
      expect(item.categories.some((category) => category.startsWith("user/1/"))).toBe(false);
    }
  });
});
