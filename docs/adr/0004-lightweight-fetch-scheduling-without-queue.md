# ADR 0004: Use lightweight scheduled fetching without a queue/job platform

- Status: Accepted
- Date: 2026-09-17

## Context

Feed retrieval is naturally retryable: HTTP GET has no intended business side effect, and Entry writes are required to be idempotent. A generalized queue, lease, and durable-job subsystem would increase infrastructure and failure-mode complexity for a single-user RSS synchronization service.

At the same time, overlapping scheduled runs or manual refreshes should not cause avoidable duplicate work, and interrupted batches must recover without corrupting state.

## Decision

v0.1 uses scheduled discovery of due Feeds, bounded batches, bounded concurrency, and a lightweight per-Feed fetch claim.

Each Feed commits independently. Scheduling state is advanced only as part of that Feed's result handling. Claim expiry is not treated as proof that an older executor has stopped; correctness instead relies on idempotent Feed processing and stable Entry identity.

Cloudflare Queues and a generalized background-job state machine are out of scope for v0.1.

## Consequences

### Positive
- Much smaller operational surface.
- Interrupted runs recover naturally on later schedules.
- Rare duplicate fetches are harmless by design.

### Negative
- The system does not provide exactly-once execution.
- Very large future workloads may require a different scheduling architecture.
