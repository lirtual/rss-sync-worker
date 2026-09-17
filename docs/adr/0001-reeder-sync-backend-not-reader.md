# ADR 0001: Build a Reeder synchronization backend, not a second reader

- Status: Accepted
- Date: 2026-09-17

## Context

The intended user already uses Reeder as the reading interface. A complete RSS reader would duplicate presentation, account, session, and interaction surfaces that are not needed for the product goal. The previous LaraFeed-based approach bundled a web reader and several optional platform features with compatibility APIs, increasing operational and behavioral surface area.

## Decision

`rss-sync-worker` is a standalone synchronization backend. It owns feed retrieval, durable feed and entry state, reader synchronization semantics, OPML portability, and minimal operational diagnostics.

It will not provide a web reading UI in v0.1.

## Consequences

### Positive
- Smaller behavioral and maintenance surface.
- Reader compatibility becomes a primary contract instead of an auxiliary feature.
- Fewer unrelated authentication, UI, and background-processing concerns.

### Negative
- Administrative workflows must be available through APIs and logs rather than a graphical UI.
- The service intentionally depends on an external reader client for the end-user reading experience.
