import { adminApp } from "./admin";
import readerWorker from "./index";
import {
  cleanupRetainedEntries,
  RETENTION_BATCH_LIMIT,
  recordMaintenanceRun,
  recordQueueOutcome,
} from "./ops-store";
import { dispatchDueFeeds, processRefreshMessage } from "./refresh";

const MAINTENANCE_CRON = "17 3 * * *";

const isAdminPath = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return pathname === "/admin" || pathname.startsWith("/admin/");
};

const runMaintenance = async (env: Env, now = Date.now()): Promise<void> => {
  const deleted = await cleanupRetainedEntries(env.DB, now);
  await recordMaintenanceRun(env.DB, now);
  console.info("retention_complete", { deleted, limit: RETENTION_BATCH_LIMIT });
};

const worker = {
  fetch(request, env, ctx) {
    if (isAdminPath(request)) return adminApp.fetch(request, env, ctx);
    return readerWorker.fetch(request, env, ctx);
  },
  async scheduled(controller, env) {
    if (controller.cron === MAINTENANCE_CRON) {
      await runMaintenance(env);
      return;
    }
    await dispatchDueFeeds(env);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const correlation = message.body.dispatchToken.slice(0, 8);
      try {
        const outcome = await processRefreshMessage(env, message.body);
        try {
          await recordQueueOutcome(
            env.DB,
            Date.now(),
            outcome === "failed" ? "error" : "success",
            outcome === "failed" ? "feed_refresh_failed" : null,
          );
        } catch (stateError) {
          console.error("queue_state_record_failed", {
            feedId: message.body.feedId,
            correlation,
            errorClass: stateError instanceof Error ? stateError.name : "unknown",
          });
        }
        console.info("queue_refresh_complete", {
          feedId: message.body.feedId,
          correlation,
          outcome,
        });
        message.ack();
      } catch (error) {
        try {
          await recordQueueOutcome(
            env.DB,
            Date.now(),
            "error",
            error instanceof Error ? error.name : "unknown",
          );
        } catch {
          // The queue retry remains the source of truth if operational-state recording also fails.
        }
        console.error("queue_refresh_exception", {
          feedId: message.body.feedId,
          correlation,
          errorClass: error instanceof Error ? error.name : "unknown",
        });
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, RefreshMessage>;

export default worker;
