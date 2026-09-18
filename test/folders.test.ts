import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const readerHeaders = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const post = (path: string, values: Array<[string, string]>) => {
  const body = new URLSearchParams();
  for (const [key, value] of values) body.append(key, value);
  return exports.default.fetch(
    new Request(`https://rss-sync.test/api/reader/reader/api/0/${path}`, {
      method: "POST",
      headers: readerHeaders,
      body,
    }),
  );
};

const get = (path: string) =>
  exports.default.fetch(
    new Request(`https://rss-sync.test/api/reader/reader/api/0/${path}`, {
      headers: { Authorization: readerHeaders.Authorization },
    }),
  );

const oneItemFeed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Folder Feed</title><link>https://folders.example/</link>
<item><guid>folder-entry</guid><title>Folder Entry</title><link>https://folders.example/entry</link></item>
</channel></rss>`;

describe("folders and subscription lifecycle", () => {
  it("supports many-to-many folder membership and idempotent edits", async () => {
    const feedId = await ensureSubscription(env.DB, "https://folders.example/feed.xml", Date.now());

    const edit = await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "edit"],
      ["a", "user/-/label/Engineering"],
      ["a", "user/-/label/Reading"],
      ["t", "Custom Folder Feed"],
    ]);
    expect(edit.status).toBe(200);

    const duplicate = await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["ac", "edit"],
      ["a", "user/-/label/Engineering"],
    ]);
    expect(duplicate.status).toBe(200);

    const tags = (await (await get("tag/list")).json()) as { tags: Array<{ id: string }> };
    expect(tags.tags.map((tag) => tag.id).sort()).toEqual([
      "user/-/label/Engineering",
      "user/-/label/Reading",
      "user/-/state/com.google/starred",
    ]);

    const list = (await (await get("subscription/list")).json()) as {
      subscriptions: Array<{
        id: string;
        title: string;
        categories: Array<{ id: string }>;
      }>;
    };
    const subscription = list.subscriptions.find((item) => item.id === `feed/${feedId}`);
    expect(subscription?.title).toBe("Custom Folder Feed");
    expect(subscription?.categories.map((category) => category.id).sort()).toEqual([
      "user/-/label/Engineering",
      "user/-/label/Reading",
    ]);

    const removeTwice = () =>
      post("subscription/edit", [
        ["s", `feed/${feedId}`],
        ["ac", "edit"],
        ["r", "user/-/label/Reading"],
      ]);
    expect((await removeTwice()).status).toBe(200);
    expect((await removeTwice()).status).toBe(200);
  });

  it("renames and deletes folders without deleting subscriptions", async () => {
    const feedId = await ensureSubscription(env.DB, "https://rename.example/feed.xml", Date.now());
    await post("subscription/edit", [
      ["s", `feed/${feedId}`],
      ["a", "user/-/label/Old Name"],
    ]);
    const before = await env.DB.prepare("SELECT id FROM folders WHERE name = 'Old Name'").first<{
      id: number;
    }>();

    expect(
      (
        await post("rename-tag", [
          ["s", "user/-/label/Old Name"],
          ["dest", "user/-/label/New Name"],
        ])
      ).status,
    ).toBe(200);
    const after = await env.DB.prepare("SELECT id FROM folders WHERE name = 'New Name'").first<{
      id: number;
    }>();
    expect(after?.id).toBe(before?.id);

    expect((await post("disable-tag", [["s", "user/-/label/New Name"]])).status).toBe(200);
    const subscription = await env.DB.prepare("SELECT active FROM subscriptions WHERE feed_id = ?")
      .bind(feedId)
      .first<{ active: number }>();
    expect(subscription?.active).toBe(1);
  });

  it("preserves history and state across unsubscribe and resubscribe", async () => {
    const now = Date.now() - 10_000;
    const feedId = await ensureSubscription(env.DB, "https://lifecycle.example/feed.xml", now);
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

    expect(
      (
        await post("subscription/edit", [
          ["s", `feed/${feedId}`],
          ["ac", "unsubscribe"],
        ])
      ).status,
    ).toBe(200);
    const inactiveList = (await (await get("subscription/list")).json()) as {
      subscriptions: Array<{ id: string }>;
    };
    expect(inactiveList.subscriptions.some((item) => item.id === `feed/${feedId}`)).toBe(false);

    expect(
      (
        await post("subscription/edit", [
          ["s", `feed/${feedId}`],
          ["ac", "subscribe"],
        ])
      ).status,
    ).toBe(200);
    const state = await env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(es.is_starred) AS starred
       FROM entries e JOIN entry_states es ON es.entry_id = e.id
       WHERE e.feed_id = ?`,
    )
      .bind(feedId)
      .first<{ total: number; starred: number }>();
    expect(state).toEqual({ total: 1, starred: 1 });
  });
});
