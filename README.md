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

`npm run check` runs Biome, TypeScript, the workerd-backed Vitest suite, and a Wrangler dry-run build.

The repository intentionally keeps production credentials out of source control. Configure these Worker secrets before deployment:

- `READER_USERNAME`
- `READER_TOKEN`
- `ADMIN_TOKEN`

`wrangler.jsonc` currently contains an all-zero D1 `database_id` placeholder so local development and CI can share the binding shape. Replace it with the real Cloudflare D1 database ID before the first production deployment.

### Foundation endpoints

- `GET /health` — public, non-sensitive health response
- `GET /admin/status` — minimal authenticated admin seam; expanded in a later ticket
- `POST /api/reader/accounts/ClientLogin` — Google Reader-compatible Reeder login
- `GET /api/reader/reader/api/0/token` — protected Reader token endpoint
- `GET /api/reader/reader/api/0/user-info` — protected single-user profile endpoint

## Design documents

- [`CONTEXT.md`](CONTEXT.md) — canonical domain vocabulary
- [`docs/specs/rss-sync-worker-v0.1.md`](docs/specs/rss-sync-worker-v0.1.md) — approved v0.1 technical specification
- [`docs/adr/`](docs/adr/) — architectural decision records

## Non-goals for v0.1

No web UI, multi-user account system, Fever API, AI features, full-text webpage extraction, image proxy, or generalized application-level background-job framework.
