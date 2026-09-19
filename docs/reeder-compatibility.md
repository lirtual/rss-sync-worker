# Reeder compatibility surface

`rss-sync-worker` implements a deliberately small Google Reader API subset for Reeder. It does **not** claim full Google Reader compatibility.

## Reeder configuration

Use the service base URL ending in `/api/reader` and the configured single-user credentials:

- username: `READER_USERNAME`
- password/app token: `READER_TOKEN`

Admin APIs use a separate Bearer `ADMIN_TOKEN` and are not part of the Reeder protocol surface.

## Supported Reader endpoints

| Method | Path | v0.2 behavior |
| --- | --- | --- |
| POST | `/accounts/ClientLogin` | Single-user login; returns SID/LSID/Auth credential lines. |
| GET | `/reader/api/0/token` | Returns the configured Reader token after Reader authentication. |
| GET | `/reader/api/0/user-info` | Returns the single configured Reader identity. |
| GET | `/reader/api/0/tag/list` | Lists persisted folders/labels. |
| POST | `/reader/api/0/rename-tag` | Renames a folder; merge-on-name-conflict preserves memberships. |
| POST | `/reader/api/0/disable-tag` | Deletes a folder and its memberships without deleting feeds or entries. |
| GET | `/reader/api/0/subscription/list` | Lists active subscriptions, effective titles, many-to-many folders, site URL, and Worker-hosted icon URL when available. |
| POST | `/reader/api/0/subscription/edit` | Subscribe, unsubscribe, custom title, and add/move folder membership. Removing a subscription label through `r` is explicitly unsupported. |
| POST | `/reader/api/0/subscription/quickadd` | Validates a direct Feed or performs bounded webpage discovery, then adds/reactivates the discovered Feed and queues refresh work. |
| GET | `/reader/api/0/stream/items/ids` | Stable keyset item-ID pagination with opaque continuation. |
| POST | `/reader/api/0/stream/items/contents` | Returns up to 100 requested item bodies with stable source metadata and enclosure arrays. |
| POST | `/reader/api/0/edit-tag` | Idempotent read/unread/kept-unread and star/unstar mutations. |
| POST | `/reader/api/0/mark-all-as-read` | Server-side bulk read over reading-list, feed, or folder scope. |

Authenticated unknown Reader endpoints return `[]` with HTTP 200, matching the pinned Miniflux baseline. Unsupported state-changing operations are explicitly rejected.

## Supported streams

`stream/items/ids` and bulk-read behavior support the combinations required by the v0.2 contract:

- `user/-/state/com.google/reading-list`
- `user/-/state/com.google/starred`
- unread filtering through `xt=user/-/state/com.google/read`
- `feed/<numeric-feed-id>`
- `user/-/label/<folder-name>`

The public item identity is the stable numeric `entries.id`. `stream/items/contents` accepts decimal IDs and the supported Google Reader long-form item representation.

## Pagination and ordering

`stream/items/ids` uses keyset pagination ordered by server-owned `(ingested_at, id)` rather than SQL `OFFSET` or publisher timestamps. The continuation value is opaque to clients.

Default limits:

- item IDs: at most 10,000 per call
- item contents: at most 100 IDs per call
- `edit-tag`: at most 1,000 item IDs per call

Newer entries arriving between pages do not invalidate the already-issued continuation boundary.

## Read/starred semantics

Every Entry has explicit Reader State. Re-observing publisher metadata or content does not reset state.

The first successful bootstrap of a subscription marks entries discovered in that bootstrap as read. Entries first discovered after bootstrap are unread by default. A failed first refresh does not establish a bootstrap boundary.

Unsubscribe marks the subscription inactive without deleting Feed/Entry history or Reader State. Resubscribe reuses the existing logical Feed when the canonical URL or an alias matches.

## `mark-all-as-read`

Bulk read is a server-side set operation over the entire selected stream; it is not a loop over the current Reeder page.

Supported scopes:

- entire reading list
- one Feed
- one Folder

When Reeder supplies `ts`, the service interprets the protocol timestamp and applies the cutoff to server-owned ingestion time. An entry first ingested after the cutoff remains unread even if its publisher `published_at` is older.

The CI release regression seeds 500 unread items and proves page size does not limit the rows marked read.

## Feed fetching behavior visible to Reeder

Subscriptions refresh asynchronously through the Queue path. v0.2 supports RSS 2.0, RSS 1.0/RDF, Atom 1.0, Atom 0.3, JSON Feed 1.0, and JSON Feed 1.1. Feed bytes are decoded using BOM, HTTP charset, XML declaration, then UTF-8 fallback; unsupported declared encodings fail explicitly instead of persisting mojibake.

Quickadd may inspect a bounded webpage and follow advertised RSS/Atom/JSON Feed links before subscription creation. Feed fetching retains conditional HTTP (`ETag` and `Last-Modified`), bounded redirects, shared SSRF checks, permanent-redirect identity migration after repeated evidence, retry backoff, duplicate Queue-delivery safety, and non-destructive source-window shrinkage.

Feed icons use the same safe-fetch boundary. Discovery priority is Feed metadata, site HTML icon links, then origin `/favicon.ico`. Found icons are cached in D1 for seven days; missing/error results are negatively cached for 24 hours. Icon discovery failure never fails a successful Feed refresh.

A failing feed remains subscribed. Successful later retrieval resets its failure streak.

## Reader item metadata

The effective source title is subscription custom title, then Feed title, then canonical Feed URL. Item responses keep stable field shapes: missing author is `""`, missing article links use empty `alternate`/`canonical` arrays, missing site URL is `origin.htmlUrl: ""`, and `enclosure` is always an array.

Relative article/media URLs in stored HTML are resolved against the article/Feed base URL. Active schemes such as `javascript:` are removed. A content-only publisher edit advances the effective Reader `updated` value without resetting read/starred state.

RSS, Atom, and JSON Feed attachment candidates are persisted as ordered enclosures and exposed to Reeder without a media proxy.

## Public icon endpoint

`GET /feed-icon/:external-id` is read-only and unauthenticated. Known icons return stored bytes with media type, ETag, bounded public cache headers, and `X-Content-Type-Options: nosniff`; matching `If-None-Match` returns 304. Unknown IDs return 404.

## Admin-only portability and diagnostics

These are not Google Reader endpoints:

- `GET /health`
- `GET /admin/status`
- `GET /admin/feeds`
- `POST /admin/feeds/:id/refresh`
- `POST /admin/opml/import`
- `GET /admin/opml/export`

OPML preserves active subscription URLs, titles, and representable folder memberships. It intentionally does not back up read/starred state.

## Explicitly unsupported in v0.2

- full historical Google Reader API coverage
- Fever API
- multi-user accounts
- web reader UI
- webpage full-text extraction
- subscription-label removal through `subscription/edit` `r`
- media proxying or image transformation
- search, sharing, comments, annotations, or push notifications
- Reader State backup through OPML
- force-concurrent refresh of a Feed that already has an unexpired dispatch

## Real-client release evidence

Automated tests define the intended protocol contract, but v0.2 is not releasable until a real Reeder client completes the release checklist in `docs/release-v0.2.md`.

For the final compatibility run, temporarily set `REEDER_TRACE=1`. The Worker logs only sanitized request shapes: credentials, Authorization values, feed URLs, item IDs, titles, folder names, timestamps, and continuation tokens are redacted or normalized. Restore `REEDER_TRACE=0` after the capture.
