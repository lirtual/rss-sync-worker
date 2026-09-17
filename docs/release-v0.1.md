# v0.1 release gate

v0.1 is not released merely because Reeder can authenticate. The release is complete only after both the automated Worker contract and a real Reeder client run pass.

## Automated evidence

The final release commit must pass `npm run check`, which runs Biome, TypeScript, workerd-backed Vitest/D1 tests, and a Wrangler dry-run build.

The suite maps to the release contract as follows:

| Behavior | Automated evidence |
| --- | --- |
| ClientLogin, token, user info, separate Admin auth | `test/worker.test.ts` |
| Bootstrap history-read boundary and later unread entries | `test/bootstrap.test.ts` |
| Stable keyset pagination and item content/ID representations | `test/item-sync.test.ts` |
| Read/unread/kept-unread and star/unstar round trips | `test/reader-state.test.ts` |
| Folder membership, rename/delete, unsubscribe/resubscribe history | `test/folders.test.ts` |
| 500-item global bulk read, feed/folder scope, ingestion cutoff | `test/mark-all.test.ts` |
| Conditional fetch, failures/backoff, redirects, duplicate delivery, retained history | `test/resilient-fetch.test.ts` |
| OPML idempotency and export/import structural recovery | `test/opml.test.ts` |
| Retention, daily Queue budget, diagnostics, manual Queue refresh | `test/operations.test.ts` |
| Credential-safe protocol trace sanitization | `test/reeder-trace.test.ts` |

Before tagging v0.1, the final integration commit must have a green CI run with all of the above present.

## Deployment prerequisites for the real-client gate

- Replace the all-zero D1 `database_id` placeholder with the production/test D1 database ID.
- Create/bind the `rss-sync-refresh` Queue.
- Apply all D1 migrations to the target database.
- Configure `READER_USERNAME`, `READER_TOKEN`, and `ADMIN_TOKEN` as secrets.
- Keep `DAILY_DISPATCH_BUDGET` at the intended deployment value (default 1600 unless deliberately changed).
- Set `REEDER_TRACE=1` only for the compatibility capture.
- Deploy the exact commit being considered for release.

Do not reuse production credentials in fixture files, screenshots, issue comments, or logs copied into the repository.

## Real Reeder run

Configure Reeder's Google Reader-compatible account to use the deployed base URL ending in `/api/reader`.

Run this sequence on the same release candidate:

- [ ] Authenticate from Reeder and complete a fresh subscription sync.
- [ ] Import/add representative RSS and Atom subscriptions and allow Queue bootstrap to finish.
- [ ] Confirm bootstrap history is not presented as a new unread backlog.
- [ ] Publish/fetch a new item and confirm it appears unread.
- [ ] Exercise item pagination/continuation across enough items to require multiple pages.
- [ ] Mark an item read, unread, starred, and unstarred; refresh Reeder between state changes.
- [ ] Create/use a backlog of several hundred unread items and run Reeder global “mark all as read”; confirm matching unread count is zero.
- [ ] Repeat mark-all for one Feed and one Folder and confirm unrelated items are untouched.
- [ ] Add, rename, move, and remove folder membership from Reeder.
- [ ] Unsubscribe and resubscribe to the same Feed; confirm logical history/state survives.
- [ ] Exercise a temporary failing Feed, then restore it and confirm automatic recovery without subscription loss.
- [ ] Export OPML, remove/rebuild the subscription structure in the test environment, import the OPML, and confirm URLs/titles/folders are restored.
- [ ] Check `/admin/status` and `/admin/feeds` during the run for unexpected failures, overdue feeds, or budget throttling.

## Capture and freeze actual Reeder traffic

With `REEDER_TRACE=1`, collect only Worker log events named `reeder_request` from the real-client run. The trace implementation normalizes or redacts sensitive values before logging.

Before committing any captured fixture, perform a second manual inspection and confirm it contains none of the following:

- Authorization header values
- Reader/Admin credentials
- email/user identity
- real Feed or article URLs
- real article/item IDs
- personal folder names or custom titles
- raw continuation tokens
- article content or OPML bodies

Freeze the ordered request shapes as `test/fixtures/reeder-v0.1-captured.json`. The fixture must state the Reeder version/platform and capture date in non-sensitive metadata. It must contain request shapes only, not responses with personal content.

Add/adjust contract tests for every distinct request shape or parameter combination observed. If real Reeder uses an endpoint or mutation not documented in `docs/reeder-compatibility.md`, the implementation and documentation must be reconciled before release.

After capture, restore `REEDER_TRACE=0` and redeploy the same code/configuration intended for normal use.

## Final release decision

The release gate passes only when:

- [ ] final CI is green;
- [ ] every real-client checklist item above is verified;
- [ ] `test/fixtures/reeder-v0.1-captured.json` comes from that real Reeder run and passes the privacy inspection;
- [ ] regression tests cover the observed request shapes;
- [ ] `docs/reeder-compatibility.md` matches the observed and implemented surface;
- [ ] tracing is disabled again;
- [ ] no open correctness issue is known to affect the supported v0.1 flow.

Until those boxes are complete, the repository may be implementation-complete but v0.1 must not be labeled released.
