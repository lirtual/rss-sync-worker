# Reeder Compatibility Completion v0.1 Technical Specification

- Status: Ready for ticketing
- Date: 2026-09-18
- Base implementation: `feat/rss-sync-worker-v0.1`
- Target client: Reeder
- Scope: complete and verify the Google Reader-compatible protocol surface required for a real Reeder synchronization session

## 1. Problem

The feed-fetching pipeline and D1 persistence are functioning, but a real Reeder client can authenticate and still show no articles. The current Worker implements only part of the protocol surface declared in the original v0.1 specification.

The current implementation already supports login, token/user info, subscription/folder mutations, `stream/items/ids`, `stream/items/contents`, reader-state mutations, and stream-wide mark-all-as-read. It does not yet provide all read-side endpoints and wire behavior Reeder can depend on during synchronization.

This specification closes that compatibility gap without expanding the product into a generic Google Reader clone.

## 2. Solution

Complete the smallest coherent Reeder-compatible protocol surface, normalize Reader authentication/parameters consistently, make stream identifiers and response envelopes internally consistent, and promote real Reeder traffic capture to a mandatory regression artifact.

Compatibility is defined by:

1. the contracts in this specification;
2. Worker-level integration tests through public HTTP + D1 seams;
3. a sanitized request-shape fixture captured from a real Reeder client.

Unknown historical Google Reader behavior remains unsupported unless Reeder actually uses it.

## 3. Governing invariants

This work preserves the existing accepted ADRs and domain rules:

- Reeder behavior defines the supported protocol surface.
- Unsupported state-changing semantics must fail explicitly rather than return a successful no-op.
- Reader State remains explicit per Entry.
- Source refreshes never reset read/starred state.
- Mark-all-as-read remains a server-side set operation over the complete selected stream.
- Stable public item identity remains `entries.id`.
- The service remains single-user.
- No additional persistence system is introduced.

No schema migration is expected for the compatibility work. An index may be added only if the new unread/stream queries otherwise require a broad scan.

## 4. User stories

1. As a Reeder user, I want a fresh synchronization to return my stored articles, so that a successful login does not produce an empty reader.
2. As a Reeder user, I want unread counts to match server state, so that Reeder can initialize and refresh badges correctly.
3. As a Reeder user, I want Reeder to read complete streams directly, so that clients are not forced to use only the item-ID/content two-step path.
4. As a Reeder user, I want reading-list, Feed, Folder, unread, and starred streams to resolve consistently, so that navigation and synchronization produce the same items.
5. As a Reeder user, I want item payloads to contain the metadata Reeder expects, so that titles, body, source, links, folders, read state, and starred state render correctly.
6. As a Reeder user, I want large result sets to paginate without duplicates or gaps, so that a full synchronization completes reliably.
7. As a Reeder user, I want read/unread and star/unstar changes to survive refreshes, so that state round-trips correctly.
8. As a Reeder user, I want mark-all-as-read to accept the timestamp representation Reeder sends, so that backlog clearing works from the client.
9. As a Reeder user, I want subscription add/edit/remove operations to accept the request shapes Reeder sends, so that subscriptions can be managed without a second UI.
10. As a Reeder user, I want folder/tag metadata to be complete enough for Reeder to reconstruct my organization, so that folder sync is stable.
11. As a Reeder user, I want a stale Reader credential to be reported as an authentication failure, so that the client can re-authenticate instead of silently failing.
12. As an operator, I want unsupported Reeder requests logged in sanitized form, so that compatibility gaps can be diagnosed without leaking credentials or personal content.
13. As an operator, I want real Reeder request shapes frozen into regression fixtures, so that future refactors do not reintroduce client incompatibilities.
14. As an operator, I want the compatibility layer to remain narrow, so that supporting Reeder does not become an open-ended implementation of the historical Google Reader API.

## 5. Protocol request normalization

### 5.1 Reader authentication

Authenticated Reader requests continue to support:

`Authorization: GoogleLogin auth=<credential>`

Invalid or expired Reader credentials return HTTP 401, not 403.

Authentication failures must remain distinguishable from malformed request failures.

For Reader write requests, the pinned Miniflux 2.3.3 contract is authoritative:

- POST authentication uses `T=<configured Reader token>`;
- an Authorization header does not replace a missing or invalid `T`;
- `T` is parsed from the normalized query/form parameter set;
- placeholder values such as `x` do not authenticate a request.

The implementation must never log Authorization values or raw edit tokens.

### 5.2 Reader POST parameter normalization

All Reader POST handlers use one shared parameter-normalization seam.

The normalized parameter multimap is the union of:

- URL query parameters;
- `application/x-www-form-urlencoded` body parameters.

Repeated values such as `i`, `a`, `r`, and `s` must be preserved.

For normal Reader POST parameters, singleton body values override query values. `edit-tag` is the exception: its state-changing `a` and `r` fields are read from the form body only, matching the pinned Miniflux implementation.

### 5.3 Stream identifier normalization

Accept equivalent incoming user stream forms:

- `user/-/...`
- `user/1/...`

Normalize them to one internal representation before dispatching stream logic.

Public protocol output must use one consistent representation across:

- `tag/list`;
- item categories;
- unread-count identifiers;
- stream envelopes.

For v0.1, canonical output is `user/-/...`.

Feed streams remain `feed/<numeric-feed-id>`.

Folder streams remain `user/-/label/<folder-name>`.

## 6. Required endpoint surface

The existing endpoints remain supported. This compatibility pass additionally requires:

- `GET /api/reader/reader/api/0/unread-count`
- `GET /api/reader/reader/api/0/stream/contents/:stream`

The path form for stream contents must also work with URL-encoded stream identifiers.

Authenticated Reader endpoints not implemented by the supported surface return the pinned Miniflux fallback: HTTP 200 with JSON `[]`. This fallback must not be confused with successful state-changing semantics on implemented endpoints, which still validate their parameters explicitly.

## 7. unread-count contract

`GET /reader/api/0/unread-count` returns a Google Reader-compatible JSON object containing `unreadcounts`.

The response must include unread counts for:

- the reading list;
- each active Feed with unread Entries;
- each Folder with unread Entries.

Each count entry contains:

- `id`: canonical stream identifier;
- `count`: exact unread count for this single-user service;
- `newestItemTimestampUsec`: ingestion timestamp of the newest unread Entry in microseconds, encoded as a decimal string.

If a stream has zero unread Entries, it may be omitted except for the reading-list aggregate, which must be present with count zero so that a client can observe a cleared backlog.

The endpoint must only count Entries visible through active subscriptions, except starred semantics already explicitly preserved elsewhere.

## 8. stream/contents contract

`GET /reader/api/0/stream/contents/:stream` returns complete items from one selected stream.

Supported streams:

- reading list;
- starred;
- one Feed;
- one Folder.

Supported query behavior:

- `n`: page size, bounded by the same service maximum used for stream reads;
- `c`: opaque continuation;
- `xt=<read-state>`: unread-only filter;
- `r=o`: oldest-first ordering;
- default ordering: newest-first;
- `ot`: lower time bound when supplied by Reeder;
- `nt`: upper time bound when supplied by Reeder.

`it` is accepted when present but is not allowed to weaken stream filtering or reader-state semantics. Any semantics observed in the real-client trace that are not covered here must be added to the contract before release.

Pagination remains keyset-based. Continuation tokens stay opaque.

The endpoint and `stream/items/ids` must use the same stream-selection semantics so that asking both paths for the same stream/filter yields the same logical Entry set.

## 9. stream/items/ids compatibility

The existing endpoint remains authoritative for stable item-ID pagination.

Required changes:

- apply shared stream normalization;
- support both newest-first and `r=o` oldest-first ordering;
- parse `ot` and `nt` when supplied;
- preserve repeated/exclusion parameters through the common request model;
- preserve item IDs as JSON strings, never JSON numbers;
- preserve opaque continuation behavior.

Unsupported exclusion streams must fail explicitly rather than silently changing semantics.

## 10. stream/items/contents response envelope

The current `{ items, updated }` response is expanded to a stable stream envelope containing at least:

- `direction`;
- `id`;
- `title`;
- `updated`;
- `items`.

`self` and `author` may be included when they can be produced deterministically without introducing user-visible fiction.

The endpoint continues to accept both decimal Entry IDs and supported Google Reader long-form IDs.

Unknown requested item IDs are ignored rather than causing the entire batch to fail. Malformed item IDs still fail the request.

## 11. Item JSON contract

Each returned Entry must preserve stable Google Reader item identity and expose:

- long-form Google Reader `id`;
- `title`;
- `timestampUsec` from ingestion time;
- `crawlTimeMsec`;
- `published`;
- `updated`;
- canonical/alternate article link when present;
- article body via `content`;
- `origin.streamId`;
- `origin.title`;
- `origin.htmlUrl` when the Feed has a site URL;
- author when available;
- categories representing:
  - reading-list;
  - read state when read;
  - starred state when starred;
  - all current Folder memberships of the active Subscription.

A `summary` may mirror a bounded textual/body representation when required by the captured Reeder contract, but this pass must not introduce webpage extraction.

Media enclosure persistence is explicitly out of scope for this compatibility pass because the current schema does not store enclosure metadata. If the real-client gate proves enclosure data is required for baseline article synchronization, that becomes a separate schema decision rather than an implicit addition here.

## 12. tag/list contract

`GET /tag/list` must return:

- all persisted user Folders;
- the built-in starred state required by Reeder.

User Folder entries include:

- canonical `id`;
- user-visible `label`;
- `type` identifying a folder/label.

Do not synthesize unrelated historical Google system tags.

Folder rename/delete semantics remain unchanged.

## 13. subscription contracts

### 13.1 subscription/list

Continue returning active subscriptions with:

- numeric Feed stream ID;
- canonical Feed URL;
- site URL where known;
- effective display title;
- complete Folder memberships.

Folder IDs use canonical normalized stream identifiers.

### 13.2 subscription/quickadd

A successful response contains at least:

- `streamId`;
- `numResults`;
- `query`;
- `streamName`.

The operation still accepts only a direct absolute RSS/Atom Feed URL. Generic webpage feed discovery remains out of scope.

### 13.3 subscription/edit

For `ac=edit` and `ac=unsubscribe`, `s=feed/<numeric-id>` remains supported.

For `ac=subscribe`, also accept the Reeder-compatible direct URL form:

`s=feed/<absolute-feed-url>`

A subscribe request using a URL resolves canonical/alias Feed identity through the existing subscription service and enqueues refresh work as needed.

`ac=edit` with `a=user/-/label/<name>` moves the subscription to that target label, matching Miniflux category semantics. Removing a subscription label through `r` is not supported by this compatibility surface and returns HTTP 400.

## 14. Reader-state mutations

### 14.1 edit-tag

Continue supporting:

- add read -> read;
- remove read -> unread;
- add kept-unread -> unread;
- add starred -> starred;
- remove starred -> unstarred.

Additionally:

- remove kept-unread -> read.

If one request contains contradictory read-state or starred-state instructions that cannot be resolved unambiguously, return HTTP 400 rather than relying on parameter order.

Equivalent repeated mutations remain idempotent.

### 14.2 mark-all-as-read timestamp parsing

`ts` accepts the timestamp magnitudes Reeder may send:

- microseconds -> convert to milliseconds;
- milliseconds -> use directly;
- Unix seconds -> convert to milliseconds.

Reject negative, non-numeric, unsafe, or implausibly small protocol timestamps instead of interpreting them as milliseconds.

Bulk-read scope and ingestion-cutoff semantics remain unchanged.

## 15. Authentication and error behavior

Reader auth outcomes:

- no credential -> 401;
- invalid credential -> 401;
- malformed operation parameters -> 400;
- unknown logical resource -> 404 where applicable;
- unsupported stream/filter on implemented endpoints -> explicit 4xx;
- authenticated unknown Reader endpoint -> 200 with JSON `[]`;
- upstream/internal transient failures -> 5xx.

When returning 401 for an invalid Reader credential, include a Reader-compatible bad-token signal if the captured Reeder behavior shows the client uses it to trigger re-authentication.

No unsupported state-changing operation may return `OK`.

## 16. Observability and real-client tracing

Keep the existing sanitized `reeder_request` tracing mechanism.

Tracing must capture request shape only:

- HTTP method;
- normalized path;
- parameter names;
- multiplicity where useful;
- normalized stream category;
- response status.

Never capture:

- Authorization values;
- Reader credentials;
- edit-token values;
- real Feed/article URLs;
- article IDs;
- folder names;
- continuation contents;
- article body.

Unknown Reader endpoint observations must include enough sanitized path/parameter shape to add a contract test.

## 17. Testing decisions

Testing stays at the highest available seam: real HTTP requests against the workerd-backed Worker with the D1 test database.

Do not add mock-heavy internal protocol tests when the behavior can be verified through the public HTTP seam.

### 17.1 Contract tests

Add/extend Worker integration tests for:

- `unread-count` aggregate, Feed, Folder, and zero-unread behavior;
- `stream/contents` for reading list, Feed, Folder, starred, and unread-only;
- identical logical selection between `stream/items/ids` and `stream/contents`;
- `user/-` and `user/1` input normalization;
- consistent canonical output identifiers;
- oldest/newest ordering;
- `ot` and `nt` filtering;
- keyset continuation in both supported directions;
- complete item envelope fields;
- item Folder categories and Feed site URL;
- POST query + form parameter merge;
- GET Authorization authentication;
- POST `T` authentication and rejection of Authorization-only writes;
- `edit-tag` body-only `a/r` semantics;
- invalid credentials returning 401;
- `tag/list` Folder + starred metadata;
- `quickadd` response shape;
- URL-form `subscription/edit ac=subscribe`;
- remove-kept-unread semantics;
- mark-all timestamp parsing for seconds, milliseconds, and microseconds;
- malformed/contradictory mutations failing explicitly;
- authenticated unknown Reader paths returning `[]` with HTTP 200.

### 17.2 Existing regression preservation

All existing v0.1 tests must remain green, especially:

- bootstrap read boundary;
- item-ID keyset pagination;
- read/starred round trips;
- Folder operations;
- 500-item mark-all regression;
- Queue/fetch resilience;
- OPML;
- dispatch/retention operations.

### 17.3 Real Reeder gate

The release candidate must be deployed from the same commit being validated.

With `REEDER_TRACE=1`:

1. remove/re-add or freshly configure the account in Reeder;
2. complete initial sync;
3. confirm existing server Entries appear;
4. confirm unread counts;
5. open reading-list, Feed, Folder, and starred views;
6. mark an item read/unread/starred/unstarred;
7. run global, Feed, and Folder mark-all;
8. add/edit/unsubscribe/resubscribe a Feed;
9. refresh again and confirm server/client state convergence.

Freeze sanitized ordered request shapes into:

`test/fixtures/reeder-v0.1-captured.json`

The fixture records Reeder version/platform and capture date, but no personal data.

Every distinct request shape observed must either:

- map to an existing contract test; or
- result in a new contract test and implementation change before release.

After capture, restore `REEDER_TRACE=0`.

## 18. Acceptance criteria

This compatibility specification is complete only when all of the following are true:

- Reeder initial sync displays Entries already stored in D1.
- Reeder refresh displays newly ingested Entries.
- Server unread count and Reeder-visible unread state converge.
- Reading-list, Feed, Folder, and starred views return expected Entries.
- Read/unread and star/unstar round-trip through a refresh.
- Mark-all works globally and by Feed/Folder across more than one page of Entries.
- Subscription and Folder mutations used by Reeder succeed with the actual request shapes.
- Invalid Reader credentials produce a re-authenticatable failure.
- No existing v0.1 regression test is weakened or removed to make compatibility pass.
- The sanitized real-client fixture exists and every observed request shape is regression-tested.
- `docs/reeder-compatibility.md` is updated to match the implemented and observed surface.
- `docs/release-v0.1.md` real-client gate is completed.
- tracing is disabled in the normal deployment.

## 19. Explicitly out of scope

- full historical Google Reader API compatibility;
- generic compatibility guarantees for clients other than Reeder;
- Fever API;
- multi-user behavior;
- OAuth or account/session management;
- expanding the Miniflux-style unknown-endpoint `[]` fallback into a claim of full Google Reader compatibility;
- search, sharing, comments, annotations, recommendations, or social features;
- webpage-to-feed discovery;
- webpage full-text extraction;
- media enclosure schema changes;
- favicon/image proxy work;
- JSON Feed support;
- changing Feed refresh scheduling policy;
- changing Queue architecture;
- replacing the explicit Entry Reader State model;
- changing OPML into a Reader State backup format.

## 20. Implementation boundary

This work should primarily remain inside the existing Reader protocol seam and stream/query helpers. It may introduce small focused helpers for:

- Reader request parameter normalization;
- stream-ID normalization;
- unread-count queries;
- stream envelope construction.

Do not fold Feed fetching, Queue scheduling, OPML, or unrelated admin behavior into the compatibility change.

The implementation must reconcile any difference between the source branch and the currently deployed Worker before deployment. The release candidate must always be reproducible from GitHub source; no compatibility fix may exist only in the Cloudflare-deployed bundle.
