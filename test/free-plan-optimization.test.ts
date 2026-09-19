import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { recordQueueOutcome, releaseDispatchSlot, reserveDispatchSlot } from "../src/ops-store";
import { enqueueFeedRefresh, processRefreshMessage } from "../src/refresh";
import { mutateEntryStates } from "../src/state-store";
import { claimDispatch, ensureSubscription, quietRefreshDelayMs } from "../src/store";

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

describe("free-plan quota and dispatch reliability", () => {
  it("does not refund an ambiguously accepted queue message", async () => {
    const now = Date.now();
    const feedId = await ensureSubscription(env.DB, "https://ambiguous-queue.example/rss", now);
    await env.DB.prepare(
      "UPDATE service_state SET budget_day = ?, dispatches_today = 0 WHERE id = 1",
    )
      .bind(utcDay(now))
      .run();
    const uncertainEnv: Env = {
      ...env,
      DB: env.DB,
      REFRESH_QUEUE: {
        send: async () => {
          throw new Error("queue response lost");
        },
      } as unknown as Queue<RefreshMessage>,
    };
    expect(await enqueueFeedRefresh(uncertainEnv, feedId, now)).toBe("delivery-uncertain");
    const token = await env.DB.prepare("SELECT dispatch_token AS token FROM feeds WHERE id = ?")
      .bind(feedId)
      .first<{ token: string | null }>();
    expect(token?.token).toBeTruthy();
    expect(await enqueueFeedRefresh(env, feedId, now)).toBe("already-dispatched");
    const used = await env.DB.prepare(
      "SELECT dispatches_today AS used FROM service_state WHERE id = 1",
    ).first<{ used: number }>();
    expect(used?.used).toBe(1);

    // A delivery that was accepted before its response was lost must still
    // commit exactly once. Replaying its token must be harmless.
    if (!token?.token) throw new Error("expected an active dispatch token");
    const message: RefreshMessage = {
      feedId,
      dispatchToken: token.token,
      dispatchedAt: now,
    };
    const fetcher = async (): Promise<Response> => new Response(null, { status: 304 });
    expect(await processRefreshMessage(env, message, now + 1, fetcher)).toBe("not-modified");
    expect(await processRefreshMessage(env, message, now + 2, fetcher)).toBe("stale");
  });

  it("does not refund a slot across UTC days and limits success heartbeats", async () => {
    const now = Date.parse("2026-09-19T23:59:30Z");
    await env.DB.prepare(
      "UPDATE service_state SET budget_day = ?, dispatches_today = 0, last_queue_success_at = NULL WHERE id = 1",
    )
      .bind(utcDay(now))
      .run();
    expect(await reserveDispatchSlot(env.DB, now, 1600)).toBe(true);
    await releaseDispatchSlot(env.DB, now + 60_000);
    const before = await env.DB.prepare(
      "SELECT dispatches_today AS used FROM service_state WHERE id = 1",
    ).first<{ used: number }>();
    expect(before?.used).toBe(1);
    await releaseDispatchSlot(env.DB, now);
    await recordQueueOutcome(env.DB, now, "success");
    await recordQueueOutcome(env.DB, now + 30_000, "success");
    const heartbeat = await env.DB.prepare(
      "SELECT last_queue_success_at AS lastAt FROM service_state WHERE id = 1",
    ).first<{ lastAt: number }>();
    expect(heartbeat?.lastAt).toBe(now);
    await recordQueueOutcome(env.DB, now + 60_000, "success");
    const next = await env.DB.prepare(
      "SELECT last_queue_success_at AS lastAt FROM service_state WHERE id = 1",
    ).first<{ lastAt: number }>();
    expect(next?.lastAt).toBe(now + 60_000);
  });

  it("authenticates Admin using the shared password and rejects blank values", async () => {
    const request = (authorization: string) =>
      new Request("https://rss-sync.test/admin/status", {
        headers: { Authorization: authorization },
      });
    const blank: Env = { ...env, DB: env.DB, PASSWORD: "" };
    const missing: Env = {
      ...env,
      DB: env.DB,
      PASSWORD: undefined as unknown as string,
    };
    expect((await adminApp.fetch(request("Bearer "), blank)).status).toBe(401);
    expect((await adminApp.fetch(request("Bearer "), missing)).status).toBe(401);
    expect((await adminApp.fetch(request("Bearer wrong-token"), env)).status).toBe(401);
    expect((await adminApp.fetch(request("Bearer test-reader-token"), env)).status).toBe(200);
  });
});

describe("free-plan database and refresh efficiency", () => {
  it("preserves unchanged reader timestamps and avoids repeated state writes", async () => {
    const now = Date.now();
    const feedId = await ensureSubscription(env.DB, "https://no-op-state.example/rss", now);
    const entry = await env.DB.prepare(
      `INSERT INTO entries (
        feed_id, identity_key, title, ingested_at, last_source_seen_at,
        content_status, created_at, updated_at
      ) VALUES (?, ?, 'Test', ?, ?, 'empty', ?, ?) RETURNING id`,
    )
      .bind(feedId, "e".repeat(64), now, now, now, now)
      .first<{ id: number }>();
    if (entry === null) throw new Error("failed to create test entry");
    await env.DB.prepare(
      "INSERT INTO entry_states (entry_id, is_read, is_starred, updated_at) VALUES (?, 0, 0, ?)",
    )
      .bind(entry.id, now)
      .run();
    expect(await mutateEntryStates(env.DB, [entry.id], { isRead: true }, now + 10)).toBe(1);
    expect(await mutateEntryStates(env.DB, [entry.id], { isRead: true }, now + 20)).toBe(0);
    expect(
      await mutateEntryStates(env.DB, [entry.id], { isRead: true, isStarred: true }, now + 30),
    ).toBe(1);
    const sql = `SELECT read_changed_at AS readAt, starred_changed_at AS starAt,
                        updated_at AS updatedAt FROM entry_states WHERE entry_id = ?`;
    const before = await env.DB.prepare(sql).bind(entry.id).first();
    expect(before).toEqual({ readAt: now + 10, starAt: now + 30, updatedAt: now + 30 });
    expect(
      await mutateEntryStates(env.DB, [entry.id], { isRead: true, isStarred: true }, now + 40),
    ).toBe(0);
    expect(await env.DB.prepare(sql).bind(entry.id).first()).toEqual(before);
  });

  it("uses a stable quiet origin with one-, two- and four-hour cadence", async () => {
    const now = Date.parse("2026-09-19T00:00:00Z");
    const hour = 60 * 60 * 1000;
    expect(quietRefreshDelayMs(now, now - 23 * hour, null, null)).toBe(hour);
    expect(quietRefreshDelayMs(now, now - 24 * hour, null, null)).toBe(2 * hour);
    expect(quietRefreshDelayMs(now, now - 7 * 24 * hour, null, null)).toBe(4 * hour);
    expect(quietRefreshDelayMs(now, null, now - 7 * 24 * hour, now - hour)).toBe(4 * hour);
    const feedId = await ensureSubscription(
      env.DB,
      "https://long-quiet.example/rss",
      now - 9 * 86400000,
    );
    await env.DB.prepare("UPDATE subscriptions SET bootstrapped_at = ? WHERE feed_id = ?")
      .bind(now - 8 * 86400000, feedId)
      .run();
    const message = await claimDispatch(env.DB, feedId, now);
    if (message === null) throw new Error("expected dispatch");
    expect(
      await processRefreshMessage(
        env,
        message,
        now + 1,
        async () => new Response(null, { status: 304 }),
      ),
    ).toBe("not-modified");
    const row = await env.DB.prepare("SELECT next_fetch_at AS nextAt FROM feeds WHERE id = ?")
      .bind(feedId)
      .first<{ nextAt: number }>();
    expect(row?.nextAt).toBe(now + 1 + 4 * hour);
  });
});
