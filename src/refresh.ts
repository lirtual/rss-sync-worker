import { decodeFeedDocument } from "./feed/decode";
import { fetchFeedDocument } from "./feed/fetch";
import { refreshExpiredFeedIcon, refreshFeedIcon } from "./feed/icon";
import { parseFeed } from "./feed/parser";
import {
  configuredDispatchBudget,
  recordCronRun,
  releaseDispatchSlot,
  reserveDispatchSlot,
  rollDispatchBudgetDay,
} from "./ops-store";
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
export type EnqueueOutcome = "enqueued" | "already-dispatched" | "budget-exhausted";

export const enqueueFeedRefresh = async (
  env: Env,
  feedId: number,
  now = Date.now(),
): Promise<EnqueueOutcome> => {
  const budget = configuredDispatchBudget(env);
  if (!(await reserveDispatchSlot(env.DB, now, budget))) return "budget-exhausted";

  const message = await claimDispatch(env.DB, feedId, now);
  if (message === null) {
    await releaseDispatchSlot(env.DB, now);
    return "already-dispatched";
  }

  try {
    await env.REFRESH_QUEUE.send(message);
  } catch (error) {
    console.error("queue_send_failed", {
      feedId,
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
  return "enqueued";
};

export interface DispatchSummary {
  due: number;
  dispatched: number;
  budgetExhausted: boolean;
}

export const dispatchDueFeeds = async (
  env: Env,
  now = Date.now(),
  limit = DEFAULT_CRON_BATCH,
): Promise<DispatchSummary> => {
  await rollDispatchBudgetDay(env.DB, now);
  await recordCronRun(env.DB, now);

  const feedIds = await listDueFeedIds(env.DB, now, limit);
  let dispatched = 0;
  let budgetExhausted = false;

  for (const feedId of feedIds) {
    try {
      const outcome = await enqueueFeedRefresh(env, feedId, now);
      if (outcome === "enqueued") dispatched += 1;
      if (outcome === "budget-exhausted") {
        budgetExhausted = true;
        break;
      }
    } catch (error) {
      console.error("feed_dispatch_failed", {
        feedId,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const summary = { due: feedIds.length, dispatched, budgetExhausted };
  console.info("cron_dispatch_complete", summary);
  return summary;
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
      try {
        await refreshExpiredFeedIcon(env.DB, feed.id, now, fetcher);
      } catch (error) {
        console.warn("feed_icon_refresh_failed", {
          feedId: feed.id,
          errorClass: error instanceof Error ? error.name : "unknown",
        });
      }
      return "not-modified";
    }

    const decoded = decodeFeedDocument(fetched.body ?? new Uint8Array(), fetched.contentType);
    const parsed = parseFeed(decoded.text);
    await persistSuccessfulRefresh(env.DB, feed, message, parsed, responseMeta, now);
    try {
      await refreshFeedIcon(env.DB, feed.id, parsed, fetched.finalUrl, now, fetcher);
    } catch (error) {
      console.warn("feed_icon_refresh_failed", {
        feedId: feed.id,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    }
    return "processed";
  } catch (error) {
    await recordRefreshFailure(env.DB, feed, message, now, error);
    return "failed";
  }
};
