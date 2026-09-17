# ADR 0002: Reeder behavior defines the supported protocol surface

- Status: Accepted
- Date: 2026-09-17

## Context

The historical Google Reader API is broad, incompletely documented, and implemented differently by modern feed servers. Claiming generic protocol compatibility can hide missing behaviors that matter to the actual client, such as stream-wide bulk read operations, pagination, and subscription mutations.

The target client is Reeder. The goal is therefore behavioral compatibility with the calls and semantics Reeder actually depends on, not maximal historical endpoint coverage.

## Decision

v0.1 will implement a tested Google Reader-compatible subset required by Reeder.

The supported surface is defined by protocol contract tests. A newly observed Reeder behavior enters the supported surface only after its request semantics are understood, a contract test is added, and the behavior is implemented.

Unsupported semantics must fail explicitly rather than return a successful no-op response.

Fever API is out of scope for v0.1.

## Consequences

### Positive
- Compatibility work is measurable by real user behavior.
- Missing critical operations cannot be hidden behind broad compatibility claims.
- Scope remains small enough for reliable maintenance.

### Negative
- Other Google Reader-compatible clients are not guaranteed to work.
- New Reeder versions may require incremental protocol work when their call patterns change.
