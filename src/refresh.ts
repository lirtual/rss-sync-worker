import { parseFeed } from "./feed/parser";
import {
  claimDispatch,
  listDueFeedIds,
  loadDispatchedFeed,
  persistSuccessfulRefresh,
  recordRefreshFailure,
} from "./store";

const DEFAULT_CRON_BATCH = 20;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const enqueueFeedRefresh = async (
  env: Env,
  feedId: number,
  now = Date.now(),
): Promise<"enqueued" | "already-dispatched"> => {
  const message = await claimDispatch(env.DB, feedId, now);
  if (message === null) return "already-dispatched";
  await env.REFRESH_QUEUE.send(message);
  return "enqueued";
};

export const dispatchDueFeeds = async (
  env: Env,
  now = Date.now(),
  limit = DEFAULT_CRON_BATCH,
): Promise<number> => {
  const feedIds = await listDueFeedIds(env.DB, now, limit);
  let dispatched = 0;

  for (const feedId of feedIds) {
    try {
      const outcome = await enqueueFeedRefresh(env, feedId, now);
      if (outcome === "enqueued") dispatched += 1;
    } catch (error) {
      console.error("feed dispatch failed", {
        feedId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return dispatched;
};

export const processRefreshMessage = async (
  env: Env,
  message: RefreshMessage,
  now = Date.now(),
  fetcher: Fetcher = fetch,
): Promise<"processed" | "stale"> => {
  const feed = await loadDispatchedFeed(env.DB, message);
  if (feed === null) return "stale";

  try {
    const response = await fetcher(feed.canonicalFeedUrl, {
      headers: {
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        "User-Agent": "rss-sync-worker/0.1",
      },
    });
    if (!response.ok) throw new Error(`feed returned HTTP ${response.status}`);

    const xml = await response.text();
    const parsed = parseFeed(xml);
    await persistSuccessfulRefresh(
      env.DB,
      feed,
      message,
      parsed,
      {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      },
      now,
    );
    return "processed";
  } catch (error) {
    await recordRefreshFailure(env.DB, message, now, error);
    throw error;
  }
};
