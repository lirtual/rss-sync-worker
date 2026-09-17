# ADR 0003: Store explicit per-entry reader state in v0.1

- Status: Accepted
- Date: 2026-09-17

## Context

Bulk read state can be represented compactly with subscription watermarks plus sparse overrides, but that model makes effective state depend on several interacting rules. The previous implementation used that style. For this project, correctness and debuggability of Reeder synchronization are more important than minimizing state writes at personal-use scale.

## Decision

v0.1 stores explicit read/unread and starred/unstarred state for each user-visible Entry.

Bulk read operations update the complete selected stream within a stable ingestion cutoff. Source metadata updates are separate from reader-state updates and must never reset reader state.

The project may revisit a watermark representation only if measured D1 write pressure proves it necessary.

## Consequences

### Positive
- Effective reader state is directly queryable and easy to reason about.
- `mark-all-as-read` behavior is straightforward to verify.
- Fewer implicit interactions between per-entry overrides and subscription-level watermarks.

### Negative
- Bulk read operations can write many rows.
- The model trades storage/write efficiency for semantic simplicity.
