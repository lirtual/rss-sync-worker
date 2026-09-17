import { fetchFeedDocument } from "./feed/fetch";
import { parseFeed } from "./feed/parser";
import {
  claimDispatch,
  listDueFeedIds,
  loadDispatchedFeed,
  persistNotModifiedRefresh,
  persistSuccessfulRefresh,
  recordRefreshFailure,
} from "./store";

const DEFAULT_CRON_BATCH = 20;
type Fetcher = typeof fetch;

export const enqueueFeedRefresh = async (
  env: Env,
  feedId: number,
  now = Date.now(),
): Promise<"enqueued" | "already-dispatched"> => {
  const message = await claimDispatch(env.DB, feedId, now);
  if (message === null) return "already-dispatched";
  try {
    await env.REFRESH_QUEUE.send(message);
  } catch (error) {
    console.error("queue send failed after dispatch claim", {
      feedId,
      error: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
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
): Promise<"processed" | "not-modified" | "failed" | "stale"> => {
  const feed = await loadDispatchedFeed(env.DB, message);
  if (feed === null) return "stale";

  try {
    const fetched = await fetchFeedDocument(
      feed.canonicalFeedUrl,
      { etag: feed.etag, lastModified: feed.lastModified },
      fetcher,
    );
    const responseMeta = {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      finalUrl: fetched.finalUrl,
      permanentRedirectTarget: fetched.permanentRedirectTarget,
    };

    if (fetched.status === "not-modified") {
      await persistNotModifiedRefresh(env.DB, feed, message, responseMeta, now);
      return "not-modified";
    }

    const parsed = parseFeed(fetched.body ?? "");
    await persistSuccessfulRefresh(env.DB, feed, message, parsed, responseMeta, now);
    return "processed";
  } catch (error) {
    await recordRefreshFailure(env.DB, feed, message, now, error);
    return "failed";
  }
};
