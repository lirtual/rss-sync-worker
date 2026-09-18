import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ensureSubscription } from "../src/store";

const root = "https://rss-sync.test/api/reader/reader/api/0";
const headers = {
  Authorization: "GoogleLogin auth=test-reader-token",
  "content-type": "application/x-www-form-urlencoded",
};

const post = (path: string, values: Array<[string, string]>) =>
  exports.default.fetch(
    new Request(`${root}/${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(values),
    }),
  );

describe("Reeder subscription wire compatibility", () => {
  it("returns the complete quickadd response without fetching synchronously", async () => {
    const url = "https://quick-shape.example/feed.xml";
    const response = await post("subscription/quickadd", [["quickadd", url]]);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      numResults: number;
      query: string;
      streamId: string;
      streamName: string;
    };
    expect(body).toMatchObject({
      numResults: 1,
      query: url,
      streamName: "",
    });
    expect(body.streamId).toMatch(/^feed\/\d+$/u);

    const feedId = Number(body.streamId.slice("feed/".length));
    const feed = await env.DB.prepare(
      "SELECT last_attempt_at AS lastAttemptAt, dispatch_token AS dispatchToken FROM feeds WHERE id = ?",
    )
      .bind(feedId)
      .first<{ lastAttemptAt: number | null; dispatchToken: string | null }>();
    expect(feed?.lastAttemptAt).toBeNull();
    expect(feed?.dispatchToken).toBeTypeOf("string");
  });

  it("subscribes URL-form streams and reuses canonical alias identity", async () => {
    const now = Date.now() - 1_000;
    const canonical = "https://canonical.example/feed.xml";
    const alias = "https://alias.example/feed.xml";
    const feedId = await ensureSubscription(env.DB, canonical, now);
    await env.DB.prepare("INSERT INTO feed_url_aliases (url, feed_id, created_at) VALUES (?, ?, ?)")
      .bind(alias, feedId, now)
      .run();
    await env.DB.prepare("UPDATE subscriptions SET active = 0, updated_at = ? WHERE feed_id = ?")
      .bind(now + 1, feedId)
      .run();

    const response = await post("subscription/edit", [
      ["s", `feed/${alias}`],
      ["ac", "subscribe"],
      ["a", "user/1/label/Reused"],
    ]);
    expect(response.status).toBe(200);

    const subscriptions = await env.DB.prepare(
      "SELECT feed_id AS feedId, active FROM subscriptions ORDER BY feed_id",
    ).all<{ feedId: number; active: number }>();
    expect(subscriptions.results).toEqual([{ feedId, active: 1 }]);

    const folder = await env.DB.prepare(
      `SELECT folder.name AS name
       FROM subscription_folders sf
       JOIN folders folder ON folder.id = sf.folder_id
       WHERE sf.feed_id = ?`,
    )
      .bind(feedId)
      .first<{ name: string }>();
    expect(folder?.name).toBe("Reused");
  });

  it("fails invalid URL-form subscriptions explicitly", async () => {
    const response = await post("subscription/edit", [
      ["s", "feed/not-an-absolute-url"],
      ["ac", "subscribe"],
    ]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "BadSubscription" });
  });
});
