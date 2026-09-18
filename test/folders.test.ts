import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const readerHeaders = {
  Authorization: "GoogleLogin auth=test-reader-token",
};

const post = (path: string, values: Array<[string, string]>) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([["T", "test-reader-token"], ...values]),
    }),
  );

const getJson = (path: string) => {
  const url = new URL(`${root}/${path}`);
  url.searchParams.set("output", "json");
  return exports.default.fetch(
    new Request(url, {
      headers: readerHeaders,
    }),
  );
};

const oneItemFeed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Folder Feed</title><link>https://folders.example/</link>
<item><guid>folder-entry</guid><title>Folder Entry</title><link>https://folders.example/entry</link></item>
</channel></rss>`;

describe("Miniflux-compatible folders and subscription lifecycle", () => {
  it("moves a subscription between labels and preserves the custom title", async () => {
    const feedId = await ensureSubscription(env.DB, "https://folders.example/feed.xml", Date.now());

    const first = await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "edit"],
      ["a", "user/-/label/Engineering"],
      ["t", "Custom Folder Feed"],
    ]);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("OK");

    const moved = await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "edit"],
      ["a", "user/-/label/Reading"],
    ]);
    expect(moved.status).toBe(200);

    const tags = (await (await getJson("tag/list")).json()) as {
      tags: Array<{ id: string }>;
    };
    expect(tags.tags.map((tag) => tag.id).sort()).toEqual([
      "user/-/label/Engineering",
      "user/-/label/Reading",
      "user/-/state/com.google/starred",
    ]);

    const list = (await (await getJson("subscription/list")).json()) as {
      subscriptions: Array<{
        id: string;
        title: string;
        categories: Array<{ id: string }>;
      }>;
    };
    const subscription = list.subscriptions.find((item) => item.id === `feed/${feedId}`);
    expect(subscription?.title).toBe("Custom Folder Feed");
    expect(subscription?.categories.map((category) => category.id)).toEqual([
      "user/-/label/Reading",
    ]);

    const removeLabel = await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "edit"],
      ["r", "user/-/label/Reading"],
    ]);
    expect(removeLabel.status).toBe(400);
  });

  it("renames labels and reassigns subscriptions when labels are disabled", async () => {
    const now = Date.now();
    const movedFeed = await ensureSubscription(env.DB, "https://rename.example/feed.xml", now);
    const fallbackFeed = await ensureSubscription(env.DB, "https://fallback.example/feed.xml", now);

    await post("subscription/edit", [
      ["s", `feed/${movedFeed}`],
      ["ac", "edit"],
      ["a", "user/-/label/Old Name"],
    ]);
    await post("subscription/edit", [
      ["s", `feed/${fallbackFeed}`],
      ["ac", "edit"],
      ["a", "user/-/label/Fallback"],
    ]);

    const before = await env.DB.prepare("SELECT id FROM folders WHERE name = 'Old Name'").first<{
      id: number;
    }>();

    const renamed = await post("rename-tag", [
      ["s", "user/-/label/Old Name"],
      ["dest", "user/-/label/New Name"],
    ]);
    expect(renamed.status).toBe(200);
    expect(await renamed.text()).toBe("OK");

    const after = await env.DB.prepare("SELECT id FROM folders WHERE name = 'New Name'").first<{
      id: number;
    }>();
    expect(after?.id).toBe(before?.id);

    const disabled = await post("disable-tag", [["s", "user/-/label/New Name"]]);
    expect(disabled.status).toBe(200);
    expect(await disabled.text()).toBe("OK");

    const membership = await env.DB.prepare(
      `SELECT folder.name
       FROM subscription_folders sf
       JOIN folders folder ON folder.id = sf.folder_id
       WHERE sf.feed_id = ?`,
    )
      .bind(movedFeed)
      .first<{ name: string }>();
    expect(membership?.name).toBe("Fallback");

    const subscription = await env.DB.prepare("SELECT active FROM subscriptions WHERE feed_id = ?")
      .bind(movedFeed)
      .first<{ active: number }>();
    expect(subscription?.active).toBe(1);
  });

  it("preserves history and state across unsubscribe and URL-form resubscribe", async () => {
    const now = Date.now() - 10_000;
    const url = "https://lifecycle.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, url, now);
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");
    await processRefreshMessage(
      env,
      message,
      now + 1,
      async () => new Response(oneItemFeed, { status: 200 }),
    );
    await env.DB.prepare(
      `UPDATE entry_states
       SET is_starred = 1, starred_changed_at = ?, updated_at = ?
       WHERE entry_id = (SELECT id FROM entries WHERE feed_id = ? LIMIT 1)`,
    )
      .bind(now + 2, now + 2, feedId)
      .run();

    const unsubscribed = await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "unsubscribe"],
    ]);
    expect(unsubscribed.status).toBe(200);
    expect(await unsubscribed.text()).toBe("OK");

    const inactiveList = (await (await getJson("subscription/list")).json()) as {
      subscriptions: Array<{ id: string }>;
    };
    expect(inactiveList.subscriptions.some((item) => item.id === `feed/${feedId}`)).toBe(false);

    const subscribed = await post("subscription/edit", [
      ["s", `feed/${url}`],
      ["ac", "subscribe"],
    ]);
    expect(subscribed.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT s.feed_id AS feedId, s.active FROM subscriptions s JOIN feeds f ON f.id = s.feed_id WHERE f.canonical_feed_url = ?",
    )
      .bind(url)
      .first<{ feedId: number; active: number }>();
    expect(row).toEqual({ feedId, active: 1 });

    const state = await env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(es.is_starred) AS starred
       FROM entries e
       JOIN entry_states es ON es.entry_id = e.id
       WHERE e.feed_id = ?`,
    )
      .bind(feedId)
      .first<{ total: number; starred: number }>();
    expect(state).toEqual({ total: 1, starred: 1 });
  });
});
