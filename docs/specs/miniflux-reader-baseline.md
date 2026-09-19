# Miniflux Google Reader Compatibility Baseline

Status: implementation baseline for `rss-sync-worker`.

## Pinned upstream

The compatibility reference is pinned to:

- Miniflux release: **2.3.3**
- Miniflux Google Reader implementation commit:
  `76889f08b12c2577b37e524e645afa5dd46ff050`
- Reference files:
  - `internal/googlereader/handler.go`
  - `internal/googlereader/README.md`

Do not silently follow Miniflux `main`. Updating the baseline requires an explicit review of upstream Google Reader changes and this matrix.

## Compatibility rule

Priority order:

1. Real Reeder request/response behavior observed against production.
2. The pinned Miniflux Google Reader contract.
3. FreshRSS as a secondary cross-check when the first two are ambiguous.
4. rss-sync-worker domain invariants and Cloudflare Workers constraints.

Wire behavior follows Miniflux unless this document lists an intentional deviation. Storage and background execution are adapted for Cloudflare Workers/D1/Queues.

## Endpoint matrix

| Endpoint | Miniflux baseline | rss-sync-worker target |
| --- | --- | --- |
| `POST /accounts/ClientLogin` | form login; plain text or `output=json`; 401 on failure | Same |
| `GET /reader/api/0/token` | GoogleLogin header auth; plain token | Same |
| `GET /reader/api/0/user-info` | JSON | Same |
| `GET /reader/api/0/subscription/list?output=json` | `output=json` required | Same |
| `POST /reader/api/0/subscription/quickadd` | discover/create, return non-empty `streamName` | Same response shape; creation/fetch is asynchronous |
| `POST /reader/api/0/subscription/edit` | subscribe/edit/unsubscribe; repeated `s` for unsubscribe; exact `OK` | Same |
| `GET /reader/api/0/tag/list?output=json` | starred + labels; `output=json` required | Same |
| `POST /reader/api/0/rename-tag` | rename label; missing source = 404; exact `OK` | Same |
| `POST /reader/api/0/disable-tag` | repeated labels; reassign affected subscriptions; exact `OK` | Same semantic target |
| `GET /reader/api/0/stream/items/ids?output=json` | one `s`; n <= 10000; r/ot/nt/xt; continuation | Same filters; opaque keyset continuation |
| `POST /reader/api/0/stream/items/contents` | `output=json`; repeated item IDs; r ordering | Same |
| `POST /reader/api/0/edit-tag` | body-only a/r; read/unread/star/unstar; ignored broadcast/like; exact `OK` | Same |
| `POST /reader/api/0/mark-all-as-read` | feed/label/reading-list; published-time cutoff; exact `OK` | Same, plus millisecond timestamp tolerance |
| unknown `GET/POST /reader/api/0/*` | `[]`, HTTP 200 | Same |

## Authentication

Miniflux authentication semantics are the baseline:

- GET Reader API calls use
  `Authorization: GoogleLogin auth=<token>`.
- POST Reader API calls use merged form parameter `T=<token>`.
- A GET query token does not authenticate the request.
- A POST Authorization header does not replace `T`.
- Reader API auth failure:
  - HTTP 401
  - `X-Reader-Google-Bad-Token: true`
  - text response `Unauthorized`
- ClientLogin failure is separate and returns a JSON 401.

## Parameter parsing

- Query + standard form body are merged for normal POST parameters.
- Repeated `i`, `a`, `r`, and `s` are preserved.
- `edit-tag` reads `a` and `r` from the POST body only, matching Miniflux.
- Read endpoints that Miniflux documents with `output=json` reject other output modes.

## Identifier contract

Supported item input formats:

- `tag:google.com,2005:reader/item/<hex>`
- bare 16-character hexadecimal ID
- decimal entry ID
- `0x<hex>` remains a local backward-compatible extension

Responses:

- `stream/items/ids` emits decimal IDs as strings.
- item contents emit long Google Reader item tags.

User-specific stream IDs are normalized to `user/-/...` internally.

## Intentional deviations / extensions

These are deliberate and must remain tested:

1. **Opaque keyset continuation**
   - Miniflux uses numeric SQL offsets.
   - rss-sync-worker uses an opaque keyset token based on ingestion time + entry ID.
   - Reason: stable pagination under concurrent ingestion and better D1 behavior.

2. **Label streams in stream queries**
   - Miniflux stream/items/ids does not expose label streams.
   - rss-sync-worker supports them as a Reeder extension.

3. **`GET /stream/contents/*`**
   - Reeder compatibility extension, not part of the pinned Miniflux subset.

4. **`GET /unread-count`**
   - Reeder compatibility extension.

5. **mark-all timestamp**
   - Miniflux accepts seconds or microseconds.
   - rss-sync-worker also tolerates milliseconds because existing clients/tests use them.

6. **Asynchronous subscription fetching**
   - Miniflux discovers/fetches synchronously during quickadd.
   - rss-sync-worker creates/reactivates the subscription immediately, returns existing title or canonical URL as non-empty `streamName`, and queues refresh work.

## Cloudflare Workers adapter invariants

These are runtime adaptations, not wire-contract changes:

- Feed response limit: 8 MiB.
- Feed parse limit: first 250 RSS/Atom entries per fetch.
- Queue fetch timeout: 30 seconds.
- Redirect/error bodies are canceled promptly.
- Response body decoding uses chunk collection + one final join.
- D1 entry/content persistence is set-based using JSON1.
- Bulk JSON payloads are chunked below 1.5 MiB.
- No-op entry/content conflicts do not rewrite rows.
- A normal 250-entry refresh must remain below the Workers Free D1 query-per-invocation budget.
- Existing ETag/Last-Modified conditional fetch behavior remains enabled.

## Production evidence

The following production cases were used to validate the Workers adapter:

- A feed larger than 4 MiB now succeeds under the 8 MiB limit.
- Feeds containing more than 250 entries are bounded to 250 rather than rejected.
- Previously failing Product Hunt, 二丫讲梵, two Bilibili feeds, and Epic Games all recovered.
- Re-fetching an unchanged 250-entry feed advances feed success timestamps without rewriting the 250 entry/content rows.
- Active subscription refresh failures were reduced to zero after the adapter fixes.

## Regression requirement

Every Miniflux endpoint above must have contract tests for:

- authentication source
- required parameters
- repeated parameter behavior
- response status/content type/body shape
- success body `OK` where applicable
- item/stream identifier formats
- timestamp and pagination semantics

Every intentional deviation must have a dedicated test and a comment linking it to this document.


## Intentional rss-sync-worker deviation: mark-all cutoff

Bulk mark-all-as-read uses service-owned `entries.ingested_at` as the cutoff boundary rather than publisher-controlled publication time. An article first ingested after the user's cutoff remains unread even when its published date is older than the cutoff. This preserves the rss-sync-worker Reader State invariant and is intentionally not a byte-for-byte copy of Miniflux 2.3.3 behavior.
