# RSS Sync Worker v0.1 Technical Specification

- Status: Approved for implementation
- Date: 2026-09-17
- Target: single-user Reeder synchronization backend on Cloudflare Workers Free

## 1. Problem and product boundary

The user already uses Reeder as the reading interface. The service therefore must not become a second RSS reader. Its responsibilities are limited to feed retrieval, durable article/state storage, Reeder-compatible synchronization, OPML portability, and minimal operator diagnostics.

Behavioral correctness in Reeder is the release criterion. Merely authenticating or returning HTTP 200 responses is not sufficient.

The critical regression case is: with hundreds of unread Entries, a Reeder `mark-all-as-read` operation over the reading list must leave zero unread Entries inside the requested cutoff, independent of client page size.

## 2. Runtime and implementation baseline

Use:

- Cloudflare Worker, TypeScript
- Hono for HTTP routing only
- Cloudflare D1 with SQL migrations and direct prepared statements; no ORM required
- Cloudflare Cron Triggers for due-feed discovery and bounded maintenance
- one Cloudflare Queue for Feed-refresh dispatch
- a Queue consumer in the same Worker script unless implementation evidence requires separation
- RSS 2.0 / Atom 1.0 parsing
- GitHub Actions validation

Do not introduce an application-level job framework, workflow engine, Durable Object, KV dependency, R2 dependency, or secondary database in v0.1.

Do not use Effect or another application framework solely to mirror LaraFeed.

### Free-plan constraints that shape the implementation

The design assumes the current Workers Free and D1 Free limits and must keep those values configurable rather than treating them as domain rules. In particular, Cron parsing work must stay minimal because Free Cron invocations have a small CPU budget, while Feed parsing is delegated to Queue consumers.

Default Queue dispatch budget: **2,500 Feed messages per UTC day**. A normally delivered message costs approximately three Queue operations (write, read, delete), leaving headroom below the current 10,000 operations/day Free allowance for retries and failures.

When the dispatch budget is exhausted, the service delays additional due Feeds and reports throttling in `/admin/status`; it must not silently drop them.

## 3. Secrets and authentication

Required Worker secrets:

- `USERNAME`
- `PASSWORD`

There is one logical user. Do not create users, sessions, passkeys, OAuth, registration, or token-management tables.

### Reader authentication

Google Reader compatibility is mounted under `/api/reader`.

`POST /api/reader/accounts/ClientLogin` validates `Email` against `USERNAME` and `Passwd` against `PASSWORD`, and returns a Google Reader-compatible credential response.

Authenticated API reads accept `Authorization: GoogleLogin auth=<token>`.

Authenticated API writes must support the edit token style Reeder uses; the service may use `PASSWORD` as both auth and edit token as long as protocol contract tests prove the exact wire behavior required by Reeder.

Credentials must never be logged.

### Admin authentication

`/admin/*` requires `Authorization: Bearer <PASSWORD>`. Admin and Reader share the same single-user `PASSWORD`; missing or blank values never authenticate.

`GET /health` is public and contains no sensitive data.

## 4. Logical schema

Use integer primary keys within JavaScript-safe range and UTC Unix epoch milliseconds unless the protocol requires another representation.

### `feeds`

Required fields:

- `id`
- `canonical_feed_url` unique
- `title`
- `site_url` nullable
- `etag` nullable
- `last_modified` nullable
- `last_attempt_at` nullable
- `last_success_at` nullable
- `next_fetch_at`
- `consecutive_failures`
- `last_error_class` nullable
- `last_error_message` nullable, bounded length
- `last_change_at` nullable
- `dispatch_token` nullable
- `dispatch_deadline_at` nullable
- `redirect_candidate_url` nullable
- `redirect_candidate_successes`
- `created_at`
- `updated_at`

Indexes must support due-feed discovery by `next_fetch_at` and active dispatch expiry without full scans.

### `feed_url_aliases`

- `url` primary/unique
- `feed_id`
- `created_at`

Every previous canonical URL retained during a permanent URL migration becomes an alias. Subscription addition resolves both canonical URLs and aliases before creating a new Feed.

### `subscriptions`

Single-user relation to Feed:

- `feed_id` primary key / FK
- `active`
- `custom_title` nullable
- `bootstrapped_at` nullable
- `created_at`
- `updated_at`

Inactive subscriptions retain historical state.

### `folders`

- `id`
- `name` unique under case-insensitive user-facing comparison
- `created_at`
- `updated_at`

### `subscription_folders`

- `feed_id`
- `folder_id`
- composite primary key

A Subscription may belong to multiple Folders.

### `entries`

- `id` stable public item identity
- `feed_id`
- `identity_key`
- `source_id` nullable
- `title`
- `url` nullable
- `author` nullable
- `published_at` nullable
- `source_updated_at` nullable
- `ingested_at`
- `last_source_seen_at`
- `content_status` (`stored`, `empty`, `oversized`)
- `created_at`
- `updated_at`

Unique constraint: `(feed_id, identity_key)`.

Indexes must support stable keyset pagination by stream, Feed, Folder, read state, starred state, and ingestion cutoff without broad scans.

### `entry_contents`

- `entry_id` primary key / FK
- `content_html`
- `content_hash`
- `encoded_size_bytes`
- `updated_at`

Content above the configured per-entry storage limit does not poison the fetch. Preserve Entry metadata and mark `content_status=oversized`.

### `entry_states`

One explicit state row per Entry:

- `entry_id` primary key / FK
- `is_read`
- `is_starred`
- `read_changed_at` nullable
- `starred_changed_at` nullable
- `updated_at`

Source updates never modify Reader State.

### `service_state`

Small singleton/key-value operational state for values such as:

- last Cron dispatch time
- last maintenance time
- UTC dispatch-budget day
- Feed messages dispatched in that day
- last queue-consumer success/error summary where useful

Do not turn this into a generalized job table.

## 5. Feed and Entry identity

### Feed identity

A Feed keeps one stable internal ID through resubscription and canonical URL migration.

Resolve a requested Feed URL in this order:

1. exact canonical URL match;
2. URL alias match;
3. create a new Feed only when neither exists.

### Entry identity

Within one Feed, derive `identity_key` in priority order:

1. stable RSS GUID / Atom ID;
2. canonical article URL;
3. deterministic fallback fingerprint based on stable source fields such as normalized title, publication time, and author.

Content is excluded from the fallback fingerprint so content edits do not automatically create a second Entry.

The fallback is best-effort for malformed Feeds with no stable identifier. Its limitation must be covered by tests and documentation rather than hidden.

Re-observing an Entry updates source metadata/content but does not create another logical Entry and does not alter Reader State.

## 6. Bootstrap semantics

A Feed is bootstrapped on the first successful parse for a Subscription that has never completed bootstrap.

All Entries first discovered in that successful bootstrap are inserted with `is_read=true`.

After bootstrap commits, newly discovered Entries default to `is_read=false`.

If the first fetch fails, `bootstrapped_at` remains null and no artificial boundary is created.

A resubscription to a previously bootstrapped Feed reuses existing history and does not reclassify historical Reader State.

## 7. Feed refresh scheduling and Queue semantics

### Cron dispatch

Default Cron cadence: every 5 minutes.

Cron does only lightweight work:

1. reset/roll the UTC daily dispatch counter when needed;
2. query due active Feeds with `next_fetch_at <= now` and no unexpired dispatch;
3. stop when the configured daily message budget is exhausted;
4. for each selected Feed, assign a random `dispatch_token` and `dispatch_deadline_at` through a conditional update;
5. enqueue `{feedId, dispatchToken, dispatchedAt}`;
6. count successful queue sends against the daily message budget.

If the D1 dispatch marker is written but Queue send fails, the Feed becomes eligible again after `dispatch_deadline_at`; this temporary delay is acceptable and must be observable.

Default dispatch deadline: 15 minutes.

### Queue consumer

Default consumer configuration:

- `max_batch_size = 1`
- bounded concurrency, default 4
- `max_retries = 3`
- no application-level dead-letter workflow in v0.1

Each message performs one Feed refresh. Queue delivery is at least once.

The consumer:

1. loads the Feed;
2. performs bounded HTTP retrieval;
3. parses and normalizes the Feed;
4. upserts Entries and Entry content idempotently;
5. creates explicit state for genuinely new Entries according to bootstrap status;
6. updates HTTP conditional metadata;
7. conditionally updates scheduling/failure state only if the Feed's current `dispatch_token` still equals the message token;
8. clears the matching dispatch marker on successful result commit.

A stale/duplicate consumer may still idempotently upsert source data, but it must not overwrite scheduling state created by a newer dispatch generation.

A crash after database commit but before queue acknowledgement may cause redelivery; redelivery must be harmless.

### Scheduling defaults

After a successful fetch with newly inserted Entries: next fetch in 30 minutes.

After a successful fetch with no new Entries or HTTP 304: next fetch in 60 minutes.

After failure: exponential retry beginning at 15 minutes, capped at 24 hours.

These are configuration defaults, not domain invariants.

## 8. HTTP feed retrieval and safety

Use conditional requests when metadata exists:

- `If-None-Match`
- `If-Modified-Since`

HTTP 304 is a successful no-change refresh.

Default safety limits:

- request timeout: 15 seconds
- maximum redirects: 5
- maximum Feed response body: 4 MiB
- maximum parsed Entries accepted from one response: 250
- maximum stored HTML per Entry: 512 KiB
- maximum error-message persistence: 1 KiB

Use manual redirect handling so permanent and temporary redirect status can be distinguished.

Reject retrieval targets that resolve to loopback, link-local, RFC1918/private ranges, obvious cloud metadata targets, or other internal-only destinations. Re-check redirect targets; SSRF protection applies to every hop.

XML parsing must not resolve external entities or external DTD resources.

A limit violation is a Feed failure, not a Worker-wide failure.

## 9. Redirect policy

302/303/307 are followed but never persisted as canonical migration evidence.

301/308 are followed and may become canonical migration candidates.

Default migration rule: after **three consecutive successful refreshes** whose permanent redirect chain ends at the same final Feed URL, migrate `canonical_feed_url` to that final URL and insert the previous canonical URL into `feed_url_aliases`.

Reset candidate count when the candidate changes or the evidence is not a permanent redirect.

Feed ID, Entries, Reader State, Subscription activity, and Folder membership remain unchanged by migration.

## 10. Google Reader-compatible API surface

Base URL exposed to Reeder: `/api/reader`.

Required v0.1 endpoints:

- `POST /accounts/ClientLogin`
- `GET /reader/api/0/token`
- `GET /reader/api/0/user-info`
- `GET /reader/api/0/tag/list`
- `POST /reader/api/0/rename-tag`
- `POST /reader/api/0/disable-tag`
- `GET /reader/api/0/subscription/list`
- `POST /reader/api/0/subscription/edit`
- `POST /reader/api/0/subscription/quickadd`
- `GET /reader/api/0/stream/items/ids`
- `POST /reader/api/0/stream/items/contents`
- `POST /reader/api/0/edit-tag`
- `POST /reader/api/0/mark-all-as-read`

Do not claim full historical Google Reader API compatibility.

Unknown endpoints must be logged in a credential-safe way and return an explicit compatibility response chosen by contract tests. Do not silently claim success for state-changing behavior that was not performed.

### Stream support

At minimum support:

- reading list
- unread filter (`xt=.../read` where Reeder uses it)
- starred
- one Feed
- one Folder/label where required by Reeder

### Item IDs

Internal `entries.id` is the stable public numeric identity.

Support the item-ID representations Reeder actually sends in tests, including decimal and Google Reader long-form when necessary. Conversion must be deterministic and lossless for supported IDs.

### Pagination

`stream/items/ids` uses stable keyset pagination and returns an opaque continuation token. Do not use deep SQL `OFFSET` as the persistence pagination mechanism.

The token may encode the last ordering tuple, signed or integrity-protected if necessary, but clients must not depend on its internal format.

Default maximum item IDs per call: 10,000.

`stream/items/contents` accepts at most 100 IDs per request.

Pagination ordering must remain stable when new Entries arrive between pages.

## 11. Reader mutations

### `edit-tag`

Support idempotent:

- read
- unread / kept-unread semantics required by Reeder
- star
- unstar

A repeated equivalent mutation returns success and does not create duplicate state.

### `mark-all-as-read`

This is a first-class stream operation, not a loop over a client page.

Support:

- entire reading list
- one Feed
- one Folder
- optional `ts` cutoff

Interpret the protocol timestamp format Reeder sends, but map the cutoff to service-owned ingestion ordering/time. Entries first ingested after the cutoff remain unread even when their publisher-supplied `published_at` is older than the cutoff.

The update must be bounded to the selected Stream and must never affect Entries from inactive/unrelated Subscriptions except where the selected protocol stream explicitly includes them.

### Folder mutations

Folder membership is many-to-many.

Adding an existing membership and removing a missing membership are successful idempotent operations.

Rename preserves folder identity. Delete removes the folder and memberships without deleting Feeds, Subscriptions, Entries, or Reader State.

## 12. Subscription lifecycle

### Quick add

v0.1 `quickadd` accepts a direct absolute RSS/Atom Feed URL. It does not perform generic webpage feed discovery.

On add:

1. resolve canonical/alias Feed identity;
2. create or reactivate Subscription;
3. apply requested folder/title metadata;
4. enqueue immediate bootstrap/refresh if no unexpired dispatch already exists.

### Unsubscribe

Set Subscription inactive. Do not delete the Feed or historical Entries. Existing starred state remains available to the protocol where applicable.

### Resubscribe

Reactivate the existing Subscription and Feed identity when the URL resolves to an existing canonical URL or alias. Preserve Reader State.

## 13. OPML

Admin-only endpoints:

- `POST /admin/opml/import`
- `GET /admin/opml/export`

Import accepts at most 1 MiB of OPML and supports nested outlines by mapping folder names to Folder memberships. Duplicate Feed URLs are merged idempotently through canonical/alias identity resolution.

Import creates/reactivates subscriptions and dispatches bootstrap work through the same Queue path; it must not fetch all Feeds synchronously inside the HTTP request.

Export must preserve active subscription URLs, display titles, and folder memberships sufficiently for import into another reader. OPML is not a backup format for read/starred state.

## 14. Admin and health API

### `GET /health`

Public. Returns only service up/down and schema/runtime readiness information; no feed URLs, counts tied to private reading activity, or credentials.

### `GET /admin/status`

Return at least:

- active/inactive subscription counts
- Feed count
- Entry count
- unread count
- starred count
- failed Feed count
- currently dispatched Feed count
- queue dispatches used today / configured daily message budget
- budget-throttled flag
- last Cron dispatch time
- last maintenance time
- oldest overdue Feed age

### `GET /admin/feeds`

Paginated operational list including Feed ID, URL, title, last success, next fetch, failure streak, bounded error summary, and dispatch state. It must not include article bodies.

### `POST /admin/feeds/:id/refresh`

Request an immediate Queue refresh. If an unexpired dispatch already exists, return accepted/already-dispatched instead of generating another normal dispatch. A separate force-overlap mode is out of scope.

## 15. Retention

Never automatically delete:

- unread Entries
- starred Entries

Entries eligible for cleanup:

- read
- unstarred
- older than 90 days by ingestion time

Run maintenance from a separate daily Cron trigger. Delete in bounded batches, default maximum 500 Entries per maintenance invocation, and rely on cascading content/state cleanup as defined by schema.

Remote disappearance from a Feed is never a deletion signal.

## 16. D1 efficiency requirements

The current Free tier has finite daily row-read and row-write allowances, so all regular query paths must have supporting indexes and avoid whole-table scans as data grows.

At minimum index:

- due Feed scheduling
- dispatch expiry/token lookup
- canonical/alias URL lookup
- Entry Feed + identity lookup
- Entry stream ordering
- read/unread stream selection
- starred stream selection
- Folder membership joins
- retention eligibility

Bulk state updates should use set-based SQL where possible rather than one D1 statement per Entry. The explicit state model remains authoritative; optimization must not reintroduce watermark semantics in v0.1.

## 17. Observability and failure behavior

Structured logs must cover:

- Cron start/end and number dispatched
- Queue message Feed ID and dispatch token prefix/non-secret correlation value
- fetch duration and HTTP result
- parser result
- Entries inserted/updated
- scheduling result
- retry/failure classification
- retention counts
- unknown Reader endpoint/path observations

Do not log credentials, full Authorization headers, OPML bodies, article HTML, or unbounded remote error bodies.

404, 410, timeout, 5xx, malformed XML, response oversize, parser limit, and SSRF rejection are Feed failures. None automatically unsubscribe or delete the Feed.

A successful subsequent refresh resets the failure streak.

## 18. Testing strategy

Prefer tests through public seams rather than mocks of internal functions.

### Protocol contract tests

Issue real HTTP requests against the Worker test environment and D1 test database.

Cover:

- ClientLogin success/failure
- token and user info
- tag/folder list, rename, delete
- subscription list, add, edit, unsubscribe, resubscribe
- item-ID stream retrieval
- item-content retrieval
- read/unread
- star/unstar
- Feed mark-all
- Folder mark-all
- reading-list mark-all
- keyset continuation with concurrent insertion between pages
- supported item-ID wire formats
- unknown/unsupported mutation behavior

### Mandatory regression release gate

Seed at least several hundred unread Entries across multiple Feeds and Folders. Execute reading-list `mark-all-as-read` using the same request shape captured from Reeder.

Assert:

- every in-scope Entry at/before cutoff is read;
- unread count becomes zero for that stream;
- page size does not affect the result;
- Entries ingested after cutoff remain unread even if `published_at` is old.

### Feed integration tests

Use a controllable HTTP fixture server for:

- RSS 2.0 and Atom
- HTTP 200 / 304
- ETag and Last-Modified
- permanent and temporary redirects
- redirect migration threshold
- redirect loop/limit
- timeout
- 404 / 410 / 5xx
- malformed XML
- oversized response
- oversized Entry content
- duplicate Entry delivery
- source metadata update without state reset
- fallback identity
- SSRF-blocked targets

### Queue/recovery tests

Cover:

- Cron conditional dispatch
- queue-send failure after D1 dispatch marking
- dispatch expiry and redispatch
- duplicate delivery of same dispatch token
- stale older dispatch after a newer token exists
- crash/redelivery after Entry commit
- retry exhaustion followed by future Cron redispatch
- daily Queue budget throttling and UTC reset

### OPML tests

Cover import, duplicate import, folders, export, and `import(export())` structural recovery.

### Retention tests

Prove unread and starred Entries survive; only read+unstarred Entries older than 90 days are deleted, and deletion is bounded.

## 19. User stories

1. As a Reeder user, I want to connect Reeder to my private sync backend, so that Reeder remains my only reading interface.
2. As a Reeder user, I want new Feed Entries to appear automatically, so that I do not manually manage refreshes.
3. As a Reeder user, I want read/unread state to synchronize reliably, so that state is consistent across Reeder sessions/devices.
4. As a Reeder user, I want starred state to synchronize, so that saved articles remain available.
5. As a Reeder user, I want to mark a Feed, Folder, or entire Reading List as read, so that large backlogs clear correctly.
6. As a Reeder user, I want new Entries arriving after a bulk-read cutoff to remain unread, so that new content is never silently lost.
7. As a Reeder user, I want large streams to paginate without gaps or duplicate pages, so that synchronization is complete.
8. As a Reeder user, I want to add, remove, rename, and organize subscriptions from Reeder, so that no second UI is required.
9. As a Reeder user, I want publisher edits not to reset my Reader State, so that updated articles do not become false unread items.
10. As a migrating user, I want OPML import to establish subscriptions without making all historical items unread.
11. As a migrating user, I want OPML export to preserve my subscription/folder structure, so that the service is portable.
12. As an operator, I want failing Feeds to retry without being deleted, so that temporary publisher problems do not lose data.
13. As an operator, I want permanent Feed URL changes to preserve identity and history, so that domain moves are transparent.
14. As an operator, I want a bad or malicious Feed to be resource-bounded, so that one source cannot destabilize the service.
15. As an operator, I want diagnostics without a Web UI, so that I can identify overdue, failed, throttled, or queued Feeds.
16. As an operator, I want repeated Cron/Queue execution to be safe, so that retries do not duplicate Entries or corrupt scheduling.
17. As a Free-plan user, I want refresh dispatch to respect platform allowances, so that exceeding a daily Queue allowance does not unexpectedly stop the service.

## 20. Explicit out of scope for v0.1

- Web reader UI
- multi-user accounts
- registration / Passkeys / OAuth
- Fever API
- complete historical Google Reader API
- generic website-to-feed discovery
- JSON Feed unless later required by an actual subscription
- webpage full-text extraction
- AI summaries or recommendations
- image proxy / favicon pipeline
- search UI / semantic search
- application-level jobs table or workflow engine
- exactly-once Feed execution
- push notifications
- sharing / comments / annotations
- backup of Reader State via OPML
- force-concurrent manual refresh

## 21. Release criteria

v0.1 is releasable only when the following end-to-end path passes against the Worker test environment and then against a real Reeder client:

Reeder login → subscription sync → bootstrap → Queue refresh → new unread Entry → read/unread → star/unstar → Feed/Folder/global mark-all → pagination/continuation → add/remove/resubscribe → Folder changes → duplicate Queue delivery → Feed failure/recovery → OPML export/import.

The real Reeder request sequence used for the release validation must be captured as sanitized fixtures so future protocol changes are regression-testable.
