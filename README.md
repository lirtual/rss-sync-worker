# rss-sync-worker

A lightweight, single-user RSS synchronization backend for Reeder on Cloudflare Workers.

The project intentionally provides **no web reader UI**. Reeder is the reading interface; this service fetches feeds, stores article/state data, and exposes the small Google Reader API subset that Reeder needs.

It does **not** claim full Google Reader API compatibility. See [`docs/reeder-compatibility.md`](docs/reeder-compatibility.md) for the exact supported surface.

## v0.2 compatibility capabilities

- RSS 2.0, RSS 1.0/RDF, Atom 1.0, Atom 0.3, JSON Feed 1.0/1.1, and declared legacy charset decoding
- D1-backed Feed, Entry, content, folder, and explicit read/starred state
- first-bootstrap history marked read; later new entries unread
- Google Reader-compatible Reeder login and synchronization subset
- stable keyset pagination and Google Reader item-ID forms used by the contract
- read/unread/kept-unread and star/unstar mutations
- correct server-side Feed/Folder/global `mark-all-as-read`
- subscription add/edit/unsubscribe/resubscribe, bounded webpage-to-feed discovery, and many-to-many folders
- conditional HTTP, bounded redirects, retry/backoff, permanent URL migration, duplicate-delivery safety
- D1-backed feed icons exposed through `subscription/list.iconUrl` and a bounded public icon endpoint
- RSS/Atom/JSON Feed enclosure persistence and stable Reeder attachment metadata
- custom subscription titles and stable item metadata/content-update semantics
- Admin OPML import/export without a Web UI
- protected operational status/feed diagnostics and Queue-backed manual refresh
- bounded 90-day cleanup of read + unstarred entries only
- UTC daily Queue dispatch budget with a conservative default of 1600 messages
- opt-in credential-safe Reeder request-shape tracing for the real-client release gate

## Architecture

```text
RSS / Atom / JSON Feed publishers
        ↓
Cloudflare Cron → Queue → Worker fetch/parse → D1
                                      ↑
Reeder → Google Reader API subset → Worker
                                      ↑
                  Admin API / OPML / diagnostics
```

The regular refresh Cron runs every five minutes. Feed work is dispatched through one Queue. A separate daily Cron performs bounded retention maintenance. The service does not use a generalized jobs/workflow table.

## Reeder configuration

Configure Reeder's Google Reader-compatible account with a service URL ending in:

```text
https://<your-host>/api/reader
```

Use the configured `READER_USERNAME` and `READER_TOKEN` as the account credentials.

The exact protocol endpoints, supported streams, limits, and unsupported behavior are documented in [`docs/reeder-compatibility.md`](docs/reeder-compatibility.md).

## Public and Admin endpoints

Public:

- `GET /health`
- `GET /feed-icon/:external-id` — cached feed icon bytes with ETag/cache headers

Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`:

- `GET /admin/status`
- `GET /admin/feeds?after=<feed-id>&limit=<1-100>`
- `POST /admin/feeds/:id/refresh`
- `POST /admin/opml/import`
- `GET /admin/opml/export`

Admin and Reader credentials are intentionally separate.

## Configuration

Secrets that must not be committed:

- `READER_USERNAME`
- `READER_TOKEN`
- `ADMIN_TOKEN`

Non-secret Worker variables in `wrangler.jsonc`:

- `DAILY_DISPATCH_BUDGET` — default `1600`
- `REEDER_TRACE` — default `0`; set to `1` only for the final sanitized real-Reeder capture

`wrangler.jsonc` is bound to the deployment D1 database and the `rss-sync-refresh` Queue. If you deploy this repository into another Cloudflare account, replace the D1 `database_id` with that account's database ID and create the Queue there.

Apply all migrations before using a new remote database.

## Development

Requirements: Node.js 22 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Validation:

```bash
npm run check
```

`npm run check` runs Biome, TypeScript, the workerd-backed Vitest/D1 suite, and a Wrangler dry-run build.

## Data and reliability rules

- Feed identity survives canonical URL migration and resubscription.
- Entry identity prefers source GUID/Atom ID, then canonical article URL, then a deterministic fallback fingerprint.
- Publisher updates never reset Reader State.
- Queue delivery is treated as at-least-once; duplicate/stale messages are harmless.
- A failing Feed is retried with backoff and is not automatically unsubscribed or deleted.
- Source disappearance is not a deletion signal.
- Retention never automatically deletes unread or starred Entries.
- Bulk read uses service-owned ingestion ordering rather than publisher timestamps.

## Release status

Automated tests are necessary but not sufficient for the v0.2 compatibility release. The final candidate must also pass the complete flow against a **real Reeder client**, and that actual request sequence must be captured as a sanitized regression fixture.

See [`docs/release-v0.2.md`](docs/release-v0.2.md). Until that checklist is complete, treat v0.2 as implementation-complete rather than released.

## Design documents

- [`CONTEXT.md`](CONTEXT.md) — canonical domain vocabulary
- [`docs/specs/rss-sync-worker-v0.1.md`](docs/specs/rss-sync-worker-v0.1.md) — approved technical specification
- [`docs/reeder-compatibility.md`](docs/reeder-compatibility.md) — exact Reader compatibility surface
- [`docs/release-v0.2.md`](docs/release-v0.2.md) — current automated/manual compatibility release gate
- [`docs/release-v0.1.md`](docs/release-v0.1.md) — historical v0.1 release gate
- [`docs/adr/`](docs/adr/) — architectural decision records

## Explicit non-goals for v0.2

No web UI, multi-user account system, Fever API, complete Google Reader API, webpage full-text extraction, media proxy, image transformation pipeline, AI features, search/sharing/annotations, or generalized application-level workflow engine.
