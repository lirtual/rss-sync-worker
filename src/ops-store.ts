export const DEFAULT_DAILY_DISPATCH_BUDGET = 1_600;
export const RETENTION_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const RETENTION_BATCH_LIMIT = 500;

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export const configuredDispatchBudget = (env: Env): number => {
  const parsed = Number.parseInt(env.DAILY_DISPATCH_BUDGET, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_DISPATCH_BUDGET;
};

export const rollDispatchBudgetDay = async (db: D1Database, now: number): Promise<void> => {
  const day = utcDay(now);
  await db
    .prepare(
      `UPDATE service_state
       SET budget_day = ?, dispatches_today = 0, updated_at = ?
       WHERE id = 1 AND (budget_day IS NULL OR budget_day <> ?)`,
    )
    .bind(day, now, day)
    .run();
};

export const reserveDispatchSlot = async (
  db: D1Database,
  now: number,
  budget: number,
): Promise<boolean> => {
  const day = utcDay(now);
  const result = await db
    .prepare(
      `UPDATE service_state
       SET budget_day = ?,
           dispatches_today = CASE WHEN budget_day = ? THEN dispatches_today + 1 ELSE 1 END,
           updated_at = ?
       WHERE id = 1
         AND (budget_day IS NULL OR budget_day <> ? OR dispatches_today < ?)`,
    )
    .bind(day, day, now, day, budget)
    .run();
  return (result.meta.changes ?? 0) === 1;
};

export const releaseDispatchSlot = async (db: D1Database, now: number): Promise<void> => {
  const day = utcDay(now);
  await db
    .prepare(
      `UPDATE service_state
       SET dispatches_today = dispatches_today - 1, updated_at = ?
       WHERE id = 1 AND budget_day = ? AND dispatches_today > 0`,
    )
    .bind(now, day)
    .run();
};

export const recordCronRun = async (db: D1Database, now: number): Promise<void> => {
  await db
    .prepare("UPDATE service_state SET last_cron_at = ?, updated_at = ? WHERE id = 1")
    .bind(now, now)
    .run();
};

export const recordMaintenanceRun = async (db: D1Database, now: number): Promise<void> => {
  await db
    .prepare("UPDATE service_state SET last_maintenance_at = ?, updated_at = ? WHERE id = 1")
    .bind(now, now)
    .run();
};

export const recordQueueOutcome = async (
  db: D1Database,
  now: number,
  outcome: "success" | "error",
  errorClass: string | null = null,
): Promise<void> => {
  if (outcome === "success") {
    await db
      .prepare(
        `UPDATE service_state
         SET last_queue_success_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(now, now)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE service_state
       SET last_queue_error_at = ?, last_queue_error_class = ?, updated_at = ?
       WHERE id = 1`,
    )
    .bind(now, errorClass?.slice(0, 128) ?? "queue_error", now)
    .run();
};

export const cleanupRetainedEntries = async (
  db: D1Database,
  now: number,
  limit = RETENTION_BATCH_LIMIT,
): Promise<number> => {
  const boundedLimit = Math.max(1, Math.min(limit, RETENTION_BATCH_LIMIT));
  const cutoff = Math.max(0, now - RETENTION_AGE_MS);
  const candidate = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT e.id
         FROM entries e
         JOIN entry_states es ON es.entry_id = e.id
         WHERE es.is_read = 1
           AND es.is_starred = 0
           AND e.ingested_at < ?
         ORDER BY e.ingested_at, e.id
         LIMIT ?
       )`,
    )
    .bind(cutoff, boundedLimit)
    .first<{ count: number }>();
  const count = candidate?.count ?? 0;
  if (count === 0) return 0;

  await db
    .prepare(
      `DELETE FROM entries
       WHERE id IN (
         SELECT e.id
         FROM entries e
         JOIN entry_states es ON es.entry_id = e.id
         WHERE es.is_read = 1
           AND es.is_starred = 0
           AND e.ingested_at < ?
         ORDER BY e.ingested_at, e.id
         LIMIT ?
       )`,
    )
    .bind(cutoff, boundedLimit)
    .run();
  return count;
};

interface ServiceStateRow {
  lastCronAt: number | null;
  lastMaintenanceAt: number | null;
  budgetDay: string | null;
  dispatchesToday: number;
  lastQueueSuccessAt: number | null;
  lastQueueErrorAt: number | null;
  lastQueueErrorClass: string | null;
}

interface CountsRow {
  activeSubscriptions: number;
  inactiveSubscriptions: number;
  feeds: number;
  entries: number;
  unread: number;
  starred: number;
  failedFeeds: number;
  dispatchedFeeds: number;
  contentBytes: number;
  oldestDueAt: number | null;
}

export interface OperationalStatus {
  activeSubscriptions: number;
  inactiveSubscriptions: number;
  feeds: number;
  entries: number;
  unread: number;
  starred: number;
  failedFeeds: number;
  dispatchedFeeds: number;
  contentBytes: number;
  dispatchBudget: {
    day: string;
    used: number;
    limit: number;
    throttled: boolean;
  };
  lastCronAt: number | null;
  lastMaintenanceAt: number | null;
  lastQueueSuccessAt: number | null;
  lastQueueErrorAt: number | null;
  lastQueueErrorClass: string | null;
  oldestOverdueAgeMs: number | null;
}

export const getOperationalStatus = async (
  db: D1Database,
  now: number,
  budget: number,
): Promise<OperationalStatus> => {
  const [counts, state] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM subscriptions WHERE active = 1) AS activeSubscriptions,
           (SELECT COUNT(*) FROM subscriptions WHERE active = 0) AS inactiveSubscriptions,
           (SELECT COUNT(*) FROM feeds) AS feeds,
           (SELECT COUNT(*) FROM entries) AS entries,
           (SELECT COUNT(*) FROM entry_states WHERE is_read = 0) AS unread,
           (SELECT COUNT(*) FROM entry_states WHERE is_starred = 1) AS starred,
           (SELECT COUNT(*)
              FROM feeds f JOIN subscriptions s ON s.feed_id = f.id AND s.active = 1
             WHERE f.consecutive_failures > 0) AS failedFeeds,
           (SELECT COUNT(*)
              FROM feeds f JOIN subscriptions s ON s.feed_id = f.id AND s.active = 1
             WHERE f.dispatch_token IS NOT NULL AND f.dispatch_deadline_at > ?) AS dispatchedFeeds,
           (SELECT COALESCE(SUM(encoded_size_bytes), 0) FROM entry_contents) AS contentBytes,
           (SELECT MIN(f.next_fetch_at)
              FROM feeds f JOIN subscriptions s ON s.feed_id = f.id AND s.active = 1
             WHERE f.next_fetch_at <= ?) AS oldestDueAt`,
      )
      .bind(now, now)
      .first<CountsRow>(),
    db
      .prepare(
        `SELECT last_cron_at AS lastCronAt,
                last_maintenance_at AS lastMaintenanceAt,
                budget_day AS budgetDay,
                dispatches_today AS dispatchesToday,
                last_queue_success_at AS lastQueueSuccessAt,
                last_queue_error_at AS lastQueueErrorAt,
                last_queue_error_class AS lastQueueErrorClass
         FROM service_state WHERE id = 1`,
      )
      .first<ServiceStateRow>(),
  ]);

  if (counts === null || state === null) throw new Error("operations state is unavailable");
  const today = utcDay(now);
  const used = state.budgetDay === today ? state.dispatchesToday : 0;
  return {
    activeSubscriptions: counts.activeSubscriptions,
    inactiveSubscriptions: counts.inactiveSubscriptions,
    feeds: counts.feeds,
    entries: counts.entries,
    unread: counts.unread,
    starred: counts.starred,
    failedFeeds: counts.failedFeeds,
    dispatchedFeeds: counts.dispatchedFeeds,
    contentBytes: counts.contentBytes,
    dispatchBudget: {
      day: today,
      used,
      limit: budget,
      throttled: used >= budget,
    },
    lastCronAt: state.lastCronAt,
    lastMaintenanceAt: state.lastMaintenanceAt,
    lastQueueSuccessAt: state.lastQueueSuccessAt,
    lastQueueErrorAt: state.lastQueueErrorAt,
    lastQueueErrorClass: state.lastQueueErrorClass,
    oldestOverdueAgeMs: counts.oldestDueAt === null ? null : Math.max(0, now - counts.oldestDueAt),
  };
};

export interface FeedDiagnostic {
  id: number;
  url: string;
  title: string;
  active: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextFetchAt: number;
  consecutiveFailures: number;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  dispatchDeadlineAt: number | null;
}

export const listFeedDiagnostics = async (
  db: D1Database,
  afterId: number,
  limit: number,
): Promise<{ feeds: FeedDiagnostic[]; nextCursor: number | null }> => {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const result = await db
    .prepare(
      `SELECT f.id,
              f.canonical_feed_url AS url,
              COALESCE(s.custom_title, NULLIF(f.title, ''), f.canonical_feed_url) AS title,
              COALESCE(s.active, 0) AS active,
              f.last_attempt_at AS lastAttemptAt,
              f.last_success_at AS lastSuccessAt,
              f.next_fetch_at AS nextFetchAt,
              f.consecutive_failures AS consecutiveFailures,
              f.last_error_class AS lastErrorClass,
              f.last_error_message AS lastErrorMessage,
              f.dispatch_deadline_at AS dispatchDeadlineAt
       FROM feeds f
       LEFT JOIN subscriptions s ON s.feed_id = f.id
       WHERE f.id > ?
       ORDER BY f.id
       LIMIT ?`,
    )
    .bind(afterId, boundedLimit + 1)
    .all<FeedDiagnostic>();

  const hasMore = result.results.length > boundedLimit;
  const feeds = result.results.slice(0, boundedLimit);
  return {
    feeds,
    nextCursor: hasMore ? (feeds.at(-1)?.id ?? null) : null,
  };
};

export const isActiveFeed = async (db: D1Database, feedId: number): Promise<boolean> => {
  const row = await db
    .prepare("SELECT active FROM subscriptions WHERE feed_id = ?")
    .bind(feedId)
    .first<{ active: number }>();
  return row?.active === 1;
};
