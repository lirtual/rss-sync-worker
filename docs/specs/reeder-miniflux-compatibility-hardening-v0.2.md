# Reeder / Miniflux Compatibility Hardening v0.2 Technical Specification

- Status: Implementation in progress
- Date: 2026-09-19
- Repository: lirtual/rss-sync-worker
- Base: main at 987cc87395ce659132cc0e8ff73c08573aa8b587
- Target client: Reeder
- Compatibility baseline: Miniflux 2.3.3 Google Reader behavior, with explicit Cloudflare Workers adaptations
- Supersedes where conflicting: docs/specs/reeder-compatibility-v0.1.md and the affected compatibility clauses in docs/specs/rss-sync-worker-v0.1.md

## 1. Problem

The current Worker implements the main Reeder synchronization flow and passes broad protocol parity tests, but several user-visible capabilities remain incomplete even when the corresponding endpoint returns HTTP 200.

The favicon defect exposed the pattern: subscription/list always emits an empty iconUrl, so protocol shape tests pass while some Reeder subscriptions have no logo. The same class of gap exists in subscription discovery, enclosure metadata, feed format and charset handling, effective source metadata, content update semantics, and real-client regression evidence.

There is also a correctness defect in mark-all-as-read. The domain model requires the bulk-read cutoff to use service-owned ingestion time, but the current implementation prefers publisher supplied published_at when present. A late-discovered old article can therefore be incorrectly marked read.

The compatibility goal is not to clone every historical Google Reader endpoint. The goal is that the Reeder-visible behavior supported by this service is complete, deterministic, and regression-tested, while feed ingestion accepts the practical input surface already supported by the pinned Miniflux baseline.

## 2. Solution

Perform one bounded compatibility-hardening pass with three coordinated outcomes:

1. Complete Reeder-visible response data, including real feed icons, enclosures, effective source titles, stable item fields, and correct update timestamps.
2. Complete practical feed intake behavior, including webpage feed discovery, Miniflux-class feed formats, legacy charset decoding, relative URL normalization, and bounded icon discovery.
3. Replace shape-only confidence with value-level golden contracts and a sanitized real-Reeder traffic fixture so a field that is permanently empty cannot silently pass parity tests again.

Internal execution remains Cloudflare-native: D1 for durable state, one Queue for feed refresh, Cron for due-feed dispatch, and no R2, KV, Durable Object, or generalized workflow system.

## 3. Governing decisions

1. Real Reeder behavior remains the primary supported-client contract.
2. Miniflux 2.3.3 remains the pinned compatibility baseline. Do not silently follow Miniflux main.
3. The external protocol and user-visible semantics follow Miniflux unless this specification records an intentional Worker deviation.
4. Cloudflare Workers, D1, and Queue constraints determine internal implementation details.
5. Reeder-visible fields must be tested for meaningful values, not only presence or HTTP success.
6. Feed refresh and article persistence remain asynchronous through the existing Queue.
7. Lightweight discovery needed to answer a Reeder subscription request correctly may run synchronously, but it must not persist article history in the request path.
8. No new Cloudflare paid storage product is introduced.
9. The service remains single-user.
10. Existing stable feed identity, entry identity, explicit Reader State, redirect migration, and resubscription invariants remain authoritative.

## 4. User stories

1. As a Reeder user, I want each subscription to display its real site or feed icon when one is available, so that feeds are visually identifiable.
2. As a Reeder user, I want feeds without an icon to degrade cleanly, so that a missing favicon never breaks subscription sync.
3. As a Reeder user, I want to paste a website URL into Add Subscription, so that the Worker can discover the site's advertised feed instead of subscribing to HTML as if it were RSS.
4. As a Reeder user, I want invalid or undiscoverable subscription URLs to return no result instead of creating a permanently failing subscription, so that my subscription list remains clean.
5. As a Reeder user, I want RSS 1.0, RSS 2.0, Atom 0.3/1.0, and JSON Feed 1.0/1.1 sources to ingest, so that feeds supported by the Miniflux baseline do not fail only because this backend is narrower.
6. As a Reeder user, I want feeds using common legacy encodings such as GBK, GB18030, Big5, Windows-1252, and UTF-16 to decode correctly, so that titles and article bodies are not corrupted.
7. As a Reeder user, I want podcast, audio, video, image, and other feed enclosures to reach Reeder, so that attachment-bearing feeds retain their media metadata.
8. As a Reeder user, I want a renamed subscription to use the custom title consistently in subscription lists and article source metadata, so that the same feed does not appear under two names.
9. As a Reeder user, I want item metadata fields to have stable Miniflux-compatible semantics, so that Reeder rendering and state synchronization do not depend on accidental omissions.
10. As a Reeder user, I want relative article links and media URLs from feeds to resolve correctly, so that content does not contain broken links or images.
11. As a Reeder user, I want publisher content edits to advance the item's updated metadata, so that Reeder can observe a meaningful article update.
12. As a Reeder user, I want mark-all-as-read to use when the backend learned about an item, so that a newly discovered old article is not silently cleared as already read.
13. As a Reeder user, I want unread, starred, folder, and feed views to continue converging after these changes, so that compatibility improvements do not regress Reader State.
14. As an operator, I want favicon and discovery work to be bounded by size, redirect, timeout, and SSRF rules, so that hostile sites cannot destabilize the Worker.
15. As an operator, I want icon misses and failures to be negatively cached for a bounded period, so that feeds without icons do not generate repeated wasteful requests.
16. As an operator, I want compatibility regressions to fail golden contract tests when a visible field becomes empty or semantically wrong, so that API-shape-only tests cannot hide user-facing defects.
17. As an operator, I want a sanitized fixture from a real Reeder session, so that future changes are checked against requests the real client actually sends.
18. As an operator, I want documentation and implementation to describe the same supported surface, so that future agents do not reintroduce previously resolved incompatibilities.

## 5. Compatibility scope

This pass covers the existing Google Reader-compatible endpoints plus the feed ingestion behavior needed to populate them correctly.

Required Reeder endpoint behavior remains:

- POST /api/reader/accounts/ClientLogin
- GET /api/reader/reader/api/0/token
- GET /api/reader/reader/api/0/user-info
- GET /api/reader/reader/api/0/tag/list
- POST /api/reader/reader/api/0/rename-tag
- POST /api/reader/reader/api/0/disable-tag
- GET /api/reader/reader/api/0/subscription/list
- POST /api/reader/reader/api/0/subscription/edit
- POST /api/reader/reader/api/0/subscription/quickadd
- GET /api/reader/reader/api/0/unread-count
- GET /api/reader/reader/api/0/stream/contents/:stream
- GET /api/reader/reader/api/0/stream/items/ids
- POST /api/reader/reader/api/0/stream/items/contents
- POST /api/reader/reader/api/0/edit-tag
- POST /api/reader/reader/api/0/mark-all-as-read

Authenticated unknown Reader endpoints retain the pinned Miniflux fallback of JSON [] with HTTP 200. Implemented state-changing endpoints must continue to reject unsupported semantics explicitly.

## 6. Schema decisions

A new D1 migration is required.

### 6.1 feed_icons

Add one bounded icon state row per Feed.

Required fields:

- feed_id: primary key and FK to feeds
- external_id: nullable unique random identifier used in the public icon URL
- status: found or missing
- media_type: nullable
- data: nullable BLOB
- content_hash: nullable
- source_url: nullable
- checked_at: timestamp
- updated_at: timestamp

Rules:

- status=found requires external_id, media_type, data, and content_hash.
- status=missing stores negative-cache state without a public icon identifier.
- icon data is capped at 256 KiB after redirects and before persistence.
- the row is replaced atomically when the icon source or content changes.
- deleting a Feed cascades icon state.

### 6.2 entry_enclosures

Add ordered enclosure metadata per Entry.

Required fields:

- entry_id: FK to entries
- position: zero-based integer
- url: absolute HTTP(S) URL
- mime_type: nullable
- length_bytes: nullable non-negative integer
- title: nullable
- primary key: entry_id + position

Rules:

- multiple enclosures are preserved in source order.
- a refresh replaces the current enclosure set for an observed Entry.
- publisher changes to enclosures never alter Reader State.
- malformed or unsafe enclosure URLs are dropped individually rather than failing the entire Feed.

No new storage system is introduced.

## 7. Feed document retrieval and decoding

Feed fetching changes from a string-first pipeline to a byte-first pipeline.

The bounded fetcher must retain:

- HTTP(S) only
- SSRF checks on the initial target and every redirect target
- at most 5 redirects
- conditional ETag / Last-Modified requests
- current 8 MiB feed body limit
- current timeout policy
- prompt cancellation of unused bodies

Decoding order:

1. byte-order mark when present;
2. explicit HTTP Content-Type charset when present;
3. XML declaration encoding for XML feeds;
4. JSON defaults to UTF-8 when no stronger signal exists;
5. UTF-8 fallback only when no encoding was declared.

The Worker compatibility date is already new enough for the current CJK TextDecoder behavior. Required charset fixtures include UTF-8, UTF-16LE, UTF-16BE, Windows-1252, GBK or GB18030, and Big5.

If the declared encoding is unsupported, record a bounded feed failure classified as unsupported_charset. Do not silently decode with UTF-8 and persist mojibake.

## 8. Feed format support

The parser must accept the practical feed formats advertised by Miniflux 2.3.3:

- RSS 2.0
- RSS 1.0 / RDF
- Atom 1.0
- Atom 0.3
- JSON Feed 1.0
- JSON Feed 1.1

All formats normalize into the existing ParsedFeed / ParsedEntry domain plus the new icon candidates and enclosure collection.

Normalized Feed data includes:

- title
- site URL
- declared feed icon/logo candidates
- entries

Normalized Entry data includes:

- stable source identifier
- title
- canonical article URL
- author
- published time
- source updated time
- HTML/text content represented as HTML for storage
- ordered enclosures

Relative URLs are resolved against the final feed URL, entry URL, or site URL as appropriate.

Format detection must use content, not only HTTP Content-Type, because real feeds are frequently served with generic MIME types.

## 9. Subscription discovery

### 9.1 quickadd

quickadd must no longer treat every absolute HTTP(S) URL as a valid feed.

The request path performs bounded discovery only:

1. validate the supplied absolute public HTTP(S) URL;
2. fetch it with redirect and SSRF protections;
3. if the response is a supported feed format, use that final URL;
4. if the response is HTML, parse advertised alternate feed links for supported RSS, Atom, or JSON Feed MIME types;
5. resolve relative discovery links against the final page URL;
6. try discovered candidates in document order under the same safety limits until a supported feed is confirmed;
7. when no supported feed is found, return numResults=0 and do not create a Subscription;
8. when a feed is found, resolve canonical/alias Feed identity, create or reactivate the Subscription, enqueue normal refresh work, and return the discovered Feed URL and a non-empty streamName.

Discovery limits:

- HTML discovery body maximum: 1 MiB
- same redirect ceiling and SSRF policy as feed fetches
- no JavaScript execution
- no RSSBridge fallback
- no full webpage extraction

The request path may parse enough of a feed to confirm format and title, but it must not insert article history. Entry persistence remains Queue-owned.

### 9.2 subscription/edit subscribe

The URL-form ac=subscribe contract continues to accept feed/<absolute-feed-url>.

It does not perform generic webpage discovery. It may validate the direct feed target with the same bounded format detector before returning success when doing so is necessary to avoid creating an invalid subscription.

Alias and resubscription identity behavior remains unchanged.

## 10. Feed icon pipeline

### 10.1 Discovery order

For an active Feed, resolve icon candidates in this order:

1. explicit feed metadata:
   - RSS channel image URL
   - Atom icon
   - Atom logo
   - JSON Feed icon
   - JSON Feed favicon
2. site HTML link elements advertising icon, shortcut icon, or apple-touch-icon
3. site origin /favicon.ico

Prefer an explicitly declared feed icon over HTML discovery.

### 10.2 Refresh policy

Icon lookup runs after a successful feed parse when:

- no icon state exists;
- the previous result is missing and the negative-cache TTL has expired;
- the previous found icon is stale by the configured refresh TTL;
- the Feed site URL changed.

Default policy:

- found icon refresh TTL: 7 days
- missing/error retry TTL: 24 hours
- icon body maximum: 256 KiB
- maximum redirects: 5
- reuse the feed SSRF policy for every hop

Icon lookup failure must never fail an otherwise successful Feed refresh.

### 10.3 Public icon endpoint

Expose a public read-only endpoint:

- GET /feed-icon/:external_id

Requirements:

- no Reader credential is required because Reeder may fetch images independently of API authentication;
- only unguessable external_id values identify icons;
- return the stored media type and bytes;
- emit ETag from content_hash;
- honor If-None-Match with HTTP 304;
- use bounded public cache headers;
- return 404 for missing or unknown icons;
- include X-Content-Type-Options: nosniff.

No image resizing, transcoding, proxy-on-every-request, or R2 storage is introduced.

### 10.4 subscription/list

subscription/list iconUrl behavior:

- found icon: absolute Worker URL for /feed-icon/:external_id
- no icon: empty string

The response must never expose the original remote icon URL directly as the primary contract.

## 11. Enclosures

RSS enclosure elements, Atom rel=enclosure links, and JSON Feed attachments normalize into entry_enclosures.

Reader item serialization must always include enclosure as an array.

Each serialized enclosure contains at least:

- url
- type when known

Optional persisted length/title metadata need not be emitted unless Reeder traffic demonstrates a dependency.

An Entry with no enclosures emits an empty enclosure array rather than omitting the field.

## 12. Reeder-visible item metadata

Reader item JSON must use one stable value contract across stream/items/contents and stream/contents.

Required behavior:

- id remains the long-form Google Reader item ID.
- title remains the normalized source title.
- published uses source publication time when available, otherwise ingestion time.
- timestampUsec follows the pinned Miniflux meaning: publication time in microseconds when publication time is available, otherwise ingestion time.
- crawlTimeMsec uses service ingestion time.
- updated uses source_updated_at when supplied; otherwise it uses the latest service-observed metadata/content change time.
- author is emitted as a string; use an empty string when absent rather than changing object shape.
- alternate and canonical contain the absolute article URL when one exists and are empty arrays otherwise.
- content and summary remain direction=ltr with the stored normalized body.
- origin.streamId remains feed/<numeric-feed-id>.
- origin.title uses the effective subscription title: custom title first, then feed title, then canonical Feed URL.
- origin.htmlUrl is emitted as a string and uses the Feed site URL or an empty string.
- categories continue to represent reading-list, read, starred, and all current Folder memberships.
- enclosure is always present.

subscription/list and item origin must use the same effective display title.

## 13. Content normalization and update semantics

Before storage, normalize feed-supplied article HTML enough for standalone Reeder rendering.

Required normalization:

- resolve relative href URLs;
- resolve relative img/src, source/src, video/src, audio/src, poster, and enclosure-adjacent media URLs;
- normalize protocol-relative HTTP(S) URLs;
- preserve valid data that Reeder can render;
- reject javascript: and other active URL schemes in link/media attributes.

This pass does not implement webpage full-text extraction or a Miniflux media proxy.

When article body content_hash changes, entries.updated_at must advance even if title, URL, author, published time, and source_updated_at are unchanged. Publisher content edits must never reset is_read or is_starred.

## 14. mark-all-as-read correctness

This specification makes the existing domain invariant executable.

The cutoff predicate is based on service-owned ingestion time only:

- in-scope when ingested_at <= cutoff
- out-of-scope when ingested_at > cutoff

Publisher supplied published_at must not decide the bulk-read boundary.

This is an intentional deviation from Miniflux 2.3.3 and must be documented in the pinned baseline because it preserves the existing rss-sync-worker product invariant: an old article first discovered after the user's mark-all action remains unread.

The fix applies consistently to:

- reading list
- one Feed
- one Folder

Timestamp input tolerance for seconds, milliseconds, and microseconds remains unchanged.

## 15. Protocol response golden contracts

Existing endpoint tests remain, but the compatibility suite gains value-level golden assertions for Reeder-visible payloads.

At minimum freeze representative responses for:

- subscription/list with:
  - iconUrl populated
  - empty icon fallback
  - site URL
  - custom title
  - multiple Folder memberships
- one normal article item
- one article with no author or article URL
- one article with multiple enclosures
- one article whose subscription has a custom title
- read and starred category combinations
- direct stream contents
- unread-count after clearing a backlog

Golden tests must fail when a required visible field becomes permanently empty, disappears, or changes semantic source.

Do not snapshot volatile timestamps or random external icon IDs without normalization.

## 16. Testing decisions

Testing uses the highest stable seam available.

### 16.1 Worker HTTP + D1 integration tests

Verify through real Worker requests:

- subscription/list returns usable iconUrl after icon state exists;
- /feed-icon/:external_id returns bytes, media type, ETag, 304, cache headers, and 404 behavior;
- custom subscription title propagates to item origin;
- item author/htmlUrl/enclosure fields keep a stable shape;
- read/unread/starred/folder behavior remains unchanged;
- mark-all uses ingestion cutoff, including the regression where published_at is old but ingested_at is after the cutoff;
- all existing Reader auth, normalization, stream, pagination, and mutation tests remain green.

### 16.2 Feed integration fixtures

Verify the feed pipeline with controlled responses for:

- RSS 2.0
- RSS 1.0/RDF
- Atom 1.0
- Atom 0.3
- JSON Feed 1.0/1.1
- RSS/Atom/JSON enclosures
- feed-declared icon
- HTML-discovered icon
- /favicon.ico fallback
- icon missing and negative caching
- UTF-8
- UTF-16LE/BE
- Windows-1252
- GBK or GB18030
- Big5
- relative article/media URLs
- content-only article update
- oversized icon
- unsafe icon/discovery redirect
- invalid declared charset
- HTML page with no feed
- HTML page with multiple feed candidates where an earlier candidate is invalid

Use the existing injectable fetch seam where network control is required. Do not introduce broad mock-only protocol tests.

### 16.3 quickadd contract tests

Through the Reader HTTP endpoint verify:

- direct supported Feed URL -> numResults=1;
- website with advertised feed -> numResults=1 using discovered Feed URL;
- website with no supported feed -> numResults=0 and no Subscription row;
- unsafe/private discovery target -> explicit failure;
- discovered subscription still persists entries only through Queue refresh;
- canonical/alias resubscription remains idempotent.

### 16.4 Real Reeder release gate

The release candidate must be the exact deployed commit being tested.

Capture a full sanitized Reeder session with REEDER_TRACE=1 and commit:

test/fixtures/reeder-v0.2-captured.json

The fixture records only request shape plus non-sensitive Reeder version/platform/date metadata.

The manual run must verify:

- fresh account sync;
- ordinary RSS and Atom subscriptions;
- website URL quickadd discovery;
- visible logos for feeds known to expose icons, including the previously observed 爱范儿 and 阮一峰 cases when those sources remain available;
- one enclosure-bearing feed;
- custom subscription title;
- read/unread and star/unstar;
- global, Feed, and Folder mark-all;
- unsubscribe/resubscribe;
- new item after mark-all remains unread;
- no unexplained unknown Reader request shape.

After capture, restore REEDER_TRACE=0.

## 17. Documentation reconciliation

Implementation completion must update:

- docs/specs/miniflux-reader-baseline.md
- docs/reeder-compatibility.md
- docs/release-v0.1.md or its successor release gate
- README.md capability and non-goal sections

Required corrections include:

- favicon/image pipeline is no longer out of scope;
- enclosure persistence is no longer out of scope;
- quickadd webpage discovery is now supported;
- JSON Feed and the added feed formats are documented;
- mark-all's ingestion-time cutoff is explicitly listed as an intentional Miniflux deviation;
- subscription/edit label removal documentation matches actual supported behavior;
- authenticated unknown Reader endpoints are documented as [] / 200;
- real-client fixture path reflects the completed release evidence.

## 18. Operational constraints

This work must remain appropriate for a personal Workers Free deployment.

Do not add:

- R2
- KV
- Durable Objects
- a second Queue
- a generalized job table
- image transformation services

D1 icon storage is bounded by the 256 KiB per-icon limit and long refresh TTL.

Discovery and icon HTTP work must be bounded and reuse existing safety primitives rather than creating separate permissive fetch paths.

Feed refresh must still succeed when optional icon discovery fails.

Queue delivery remains at-least-once and all new enclosure/icon persistence must therefore be idempotent.

## 19. Acceptance criteria

The specification is complete when all of the following are true:

- 爱范儿 and 阮一峰 display a logo in Reeder when their current feed/site exposes a discoverable icon.
- subscription/list never hardcodes iconUrl to empty for every Feed.
- missing icons degrade to an empty iconUrl without failing sync.
- quickadd discovers a feed from a normal webpage and refuses to create a subscription when no supported feed exists.
- supported feed fixtures cover RSS 1.0/2.0, Atom 0.3/1.0, and JSON Feed 1.0/1.1.
- required legacy charset fixtures decode without mojibake.
- enclosure-bearing entries expose enclosure metadata to Reeder.
- custom subscription titles appear consistently in subscription/list and item origin.
- item payload field semantics match this specification and the pinned baseline where not explicitly deviated.
- content-only updates advance the effective item updated value without resetting Reader State.
- mark-all leaves an old-published item unread when it was ingested after the cutoff.
- existing bootstrap, pagination, unread-count, state mutation, folder, subscription lifecycle, redirect, OPML, retention, and Queue regressions remain green.
- value-level golden contracts exist for subscription and item payloads.
- test/fixtures/reeder-v0.2-captured.json exists from a real Reeder run and every distinct request shape is explained by a contract test.
- documentation matches implementation.
- normal deployment has REEDER_TRACE=0.
- no new paid Cloudflare dependency is required.

## 20. Explicitly out of scope

- full historical Google Reader API compatibility
- generic support guarantees for non-Reeder clients
- Fever API
- multi-user accounts
- OAuth/session redesign
- webpage full-text extraction
- Readability article scraping
- media proxying
- favicon resizing or transcoding
- image optimization
- R2/KV-backed media storage
- RSSBridge integration or generation of feeds from arbitrary websites
- JavaScript execution during feed discovery
- bot-protection bypass systems
- search, sharing, comments, annotations, recommendations, or social features
- push notifications
- changing the one-Queue refresh architecture
- changing feed/entry identity rules
- changing explicit Reader State to watermark-based state
- using OPML as a backup of Reader State

## 21. Implementation boundary

Expected implementation areas:

- feed byte fetch and decoding
- feed format parser normalization
- lightweight subscription discovery
- optional icon discovery/cache
- D1 migration for icons and enclosures
- refresh persistence for enclosures and content-change timestamps
- Reader item/subscription serialization
- mark-all predicate correction
- high-level compatibility/golden tests
- real-client fixture and documentation reconciliation

Do not mix unrelated admin, OPML, scheduling, or workflow refactors into this work.

The next step after approval is to run the Matt Skills Curated to-tickets workflow against this specification and decompose it into dependency-linked tracer-bullet tickets.
