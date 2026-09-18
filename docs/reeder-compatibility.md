# Reeder compatibility surface

`rss-sync-worker` implements a deliberately small Google Reader API subset for Reeder. It does **not** claim full Google Reader compatibility.

## Reeder configuration

Use the service base URL ending in `/api/reader` and the configured single-user credentials:

- username: `READER_USERNAME`
- password/app token: `READER_TOKEN`

Admin APIs use a separate Bearer `ADMIN_TOKEN` and are not part of the Reeder protocol surface.

## Supported Reader endpoints

| Method | Path | v0.1 behavior |
| --- | --- | --- |
| POST | `/accounts/ClientLogin` | Single-user login; returns SID/LSID/Auth credential lines. |
| GET | `/reader/api/0/token` | Returns the configured Reader token after Reader authentication. |
| GET | `/reader/api/0/user-info` | Returns the single configured Reader identity. |
| GET | `/reader/api/0/tag/list` | Lists persisted folders/labels. |
| POST | `/reader/api/0/rename-tag` | Renames a folder; merge-on-name-conflict preserves memberships. |
| POST | `/reader/api/0/disable-tag` | Deletes a folder and its memberships without deleting feeds or entries. |
| GET | `/reader/api/0/subscription/list` | Lists active subscriptions and many-to-many folder memberships. |
| POST | `/reader/api/0/subscription/edit` | Subscribe, unsubscribe, custom title, add/remove folder membership. |
| POST | `/reader/api/0/subscription/quickadd` | Adds/reactivates a direct absolute RSS/Atom URL and queues refresh work. |
| GET | `/reader/api/0/stream/items/ids` | Stable keyset item-ID pagination with opaque continuation. |
| POST | `/reader/api/0/stream/items/contents` | Returns up to 100 requested item bodies. |
| POST | `/reader/api/0/edit-tag` | Idempotent read/unread/kept-unread and star/unstar mutations. |
| POST | `/reader/api/0/mark-all-as-read` | Server-side bulk read over reading-list, feed, or folder scope. |

Unknown Reader endpoints return an explicit non-success response; unsupported state-changing operations are never silently accepted.

## Supported streams

`stream/items/ids` and bulk-read behavior support the combinations required by the v0.1 contract:

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

Subscriptions refresh asynchronously through the Queue path. The service supports RSS 2.0 and Atom in v0.1, conditional HTTP (`ETag` and `Last-Modified`), bounded redirects, permanent-redirect identity migration after repeated evidence, retry backoff, duplicate Queue delivery, and non-destructive source-window shrinkage.

A failing feed remains subscribed. Successful later retrieval resets its failure streak.

## Admin-only portability and diagnostics

These are not Google Reader endpoints:

- `GET /health`
- `GET /admin/status`
- `GET /admin/feeds`
- `POST /admin/feeds/:id/refresh`
- `POST /admin/opml/import`
- `GET /admin/opml/export`

OPML preserves active subscription URLs, titles, and representable folder memberships. It intentionally does not back up read/starred state.

## Explicitly unsupported in v0.1

- full historical Google Reader API coverage
- Fever API
- multi-user accounts
- webpage-to-feed discovery in `quickadd`
- JSON Feed unless later required by an actual subscription
- web reader UI
- webpage full-text extraction
- search, sharing, comments, annotations, or push notifications
- Reader State backup through OPML
- force-concurrent refresh of a Feed that already has an unexpired dispatch

## Real-client release evidence

Automated tests define the intended protocol contract, but v0.1 is not releasable until a real Reeder client completes the release checklist in `docs/release-v0.1.md`.

For the final compatibility run, temporarily set `REEDER_TRACE=1`. The Worker logs only sanitized request shapes: credentials, Authorization values, feed URLs, item IDs, titles, folder names, timestamps, and continuation tokens are redacted or normalized. Restore `REEDER_TRACE=0` after the capture.
