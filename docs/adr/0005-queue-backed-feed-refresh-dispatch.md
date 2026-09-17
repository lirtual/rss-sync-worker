# ADR 0005: Dispatch feed refreshes through Cloudflare Queues

- Status: Accepted
- Date: 2026-09-17
- Supersedes: ADR 0004

## Context

Workers Free limits Cron Triggers to 10 ms of CPU time per invocation. Network waiting does not count toward CPU, but RSS/Atom parsing and normalization do. A Cron that both discovers many due Feeds and parses them risks hitting the free-plan CPU ceiling.

Cloudflare Queues has been available on Workers Free since 2026-02-04. The free plan includes 10,000 queue operations per day and 24-hour message retention. Queue consumers provide an appropriate execution boundary for per-Feed fetch and parse work.

The service still does not need a generalized application-level job framework. Queue delivery is at least once, so duplicate delivery remains possible and must be harmless.

## Decision

v0.1 uses one Cloudflare Queue for Feed refresh dispatch.

Cron responsibilities are intentionally narrow:

1. query due Feeds;
2. atomically mark/record dispatch intent so the same due Feed is not continuously re-enqueued;
3. enqueue compact messages containing the stable Feed identifier and dispatch metadata;
4. stop.

Queue consumer responsibilities:

1. load the Feed by stable identifier;
2. fetch the remote Feed with bounded redirects, timeout, and response size;
3. parse and normalize accepted RSS/Atom content;
4. idempotently upsert Entries;
5. update Feed success/failure scheduling state;
6. acknowledge only after the Feed result is durably recorded.

Delivery semantics are at least once. Duplicate messages, retries, consumer overlap, and crash-after-commit scenarios must not create duplicate Entries or reset Reader State.

No application-level `jobs` table, durable lease framework, or exactly-once protocol is introduced in v0.1.

## Capacity policy

Queue usage must remain compatible with the Workers Free daily operation allowance. Scheduling defaults should target personal-use workloads and expose queue pressure through diagnostics. If projected refresh volume would exceed the free allowance, the system should lengthen refresh cadence or surface the constraint rather than silently dropping Feed refreshes.

## Consequences

### Positive
- Cron stays well below the Free-plan CPU-sensitive parsing path.
- Feed parsing receives an independent consumer execution boundary.
- Built-in retries and buffering replace custom retry/job orchestration.
- The design remains idempotent and tolerant of duplicate execution.

### Negative
- Adds one Cloudflare platform resource and producer/consumer configuration.
- Free-plan queue operations and 24-hour retention become explicit capacity constraints.
- Queue backlog and retry behavior must be observable.
