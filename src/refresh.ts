import { fetchFeedDocument } from "./feed/fetch";
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
export type EnqueueOutcome =
  | "enqueued"
  | "already-dispatched"
  | "budget-exhausted"
  | "delivery-uncertain";

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
    // A rejected send may already have been accepted by Queues. Do not refund the
    // budget or release the dispatch token: the original message may still arrive.
    console.error("queue_send_uncertain", {
      feedId,
      correlation: message.dispatchToken.slice(0, 8),
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    return "delivery-uncertain";
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
