# ADR 0004: Use lightweight scheduled fetching without a queue/job platform

- Status: Superseded by ADR 0005
- Date: 2026-09-17

## Context

Feed retrieval is naturally retryable: HTTP GET has no intended business side effect, and Entry writes are required to be idempotent. A generalized queue, lease, and durable-job subsystem would increase infrastructure and failure-mode complexity for a single-user RSS synchronization service.

The original design assumed Cloudflare Queues was unavailable on the Workers Free plan and therefore proposed doing due-feed discovery and bounded feed processing directly inside Cron invocations.

## Original decision

v0.1 would use scheduled discovery of due Feeds, bounded batches, bounded concurrency, and a lightweight per-Feed fetch claim, with no Cloudflare Queue.

## Why this was superseded

Current Cloudflare platform documentation shows two facts that materially change the trade-off:

1. Workers Free Cron invocations have only 10 ms of CPU time, which can be too tight for repeatedly parsing non-trivial RSS/Atom payloads in one scheduled invocation.
2. Cloudflare Queues became available on Workers Free on 2026-02-04, with a daily free allocation and Worker consumers.

Because the original decision was partly based on an outdated platform constraint, ADR 0005 replaces it with a queue-backed dispatch model while retaining the same idempotency and at-least-once assumptions.
