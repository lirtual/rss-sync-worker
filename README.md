# rss-sync-worker

A lightweight, single-user RSS synchronization backend for Reeder.

The project intentionally does **not** provide a web reader UI. Reeder is the reading interface; this service is responsible for feed fetching, durable article state, and the Reeder-compatible synchronization API.

## v0.1 goals

- RSS / Atom fetching and durable storage
- Reeder-compatible Google Reader API subset
- reliable read / unread and starred synchronization
- correct stream-wide `mark-all-as-read`
- OPML import / export
- lightweight operational diagnostics
- Cloudflare Workers + D1 + Cron + one Queue deployment

## Design documents

- [`CONTEXT.md`](CONTEXT.md) — canonical domain vocabulary
- [`docs/specs/rss-sync-worker-v0.1.md`](docs/specs/rss-sync-worker-v0.1.md) — approved v0.1 technical specification
- [`docs/adr/`](docs/adr/) — architectural decision records

## Non-goals for v0.1

No web UI, multi-user account system, Fever API, AI features, full-text webpage extraction, image proxy, or generalized application-level background-job framework.
