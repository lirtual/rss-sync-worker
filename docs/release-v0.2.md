# v0.2 Reeder compatibility release gate

v0.2 is not released merely because the automated suite is green. The release is complete only when the exact release-candidate commit passes both the Worker contract and a real Reeder client run, and the sanitized observed request shapes are frozen in `test/fixtures/reeder-v0.2-captured.json`.

## Automated evidence

The release candidate must pass `npm run check`, which runs Biome, TypeScript, workerd-backed Vitest/D1 tests, and a Wrangler dry-run build.

| Behavior | Automated evidence |
| --- | --- |
| Reader auth and base protocol surface | `test/worker.test.ts`, `test/miniflux-reader-parity.test.ts` |
| Charset decoding and safe byte-first fetch | `test/feed-charsets.test.ts`, `test/resilient-fetch.test.ts` |
| RSS/RDF/Atom/JSON Feed baseline | `test/feed-formats.test.ts` |
| Bounded webpage quickadd discovery | `test/feed-discovery.test.ts`, `test/subscription-wire.test.ts` |
| Feed icon discovery/cache/public delivery | `test/feed-icons.test.ts` |
| Ordered enclosure persistence and Reader output | `test/enclosures.test.ts` |
| Stable item metadata, custom titles, content-only updates | `test/item-metadata-v2.test.ts` |
| Reader State and state wire semantics | `test/reader-state.test.ts`, `test/reader-state-wire.test.ts` |
| Global/Feed/Folder mark-all with ingestion cutoff | `test/mark-all.test.ts` |
| Direct stream parity, pagination, contents | `test/stream-contents.test.ts`, `test/item-sync.test.ts` |
| Value-level v0.2 golden contract | `test/reeder-v0.2-golden.test.ts` |
| Credential-safe trace sanitization | `test/reeder-trace.test.ts` |
| OPML and operational regressions | `test/opml.test.ts`, `test/operations.test.ts` |

No v0.1 regression may be removed or weakened to make v0.2 pass.

## Deployment prerequisites

- Deploy the exact commit being considered for release.
- Apply every D1 migration, including enclosure and feed-icon state.
- Bind the production/test D1 database and `rss-sync-refresh` Queue.
- Configure `READER_USERNAME`, `READER_TOKEN`, and `ADMIN_TOKEN` as secrets.
- Keep the intended `DAILY_DISPATCH_BUDGET`.
- Set `REEDER_TRACE=1` only for the compatibility capture.
- Never place credentials or private Feed/article data in fixtures, screenshots, issue comments, or committed logs.

## Real Reeder v0.2 run

On one exact release candidate:

- [ ] Complete a fresh account sync.
- [ ] Add ordinary RSS and Atom subscriptions.
- [ ] Add a website URL that requires quickadd Feed discovery.
- [ ] Confirm discoverable logos render, including the previously observed 爱范儿 and 阮一峰 cases when those sources remain available.
- [ ] Add an enclosure-bearing Feed and confirm attachment metadata is usable in Reeder.
- [ ] Set a custom subscription title and confirm it is consistent in subscription and item source metadata.
- [ ] Round-trip read/unread and star/unstar across refresh.
- [ ] Run global, Feed, and Folder mark-all and confirm the selected unread set converges.
- [ ] Ingest an article after a mark-all cutoff whose publisher date is older than the cutoff; confirm it remains unread.
- [ ] Unsubscribe and resubscribe; confirm logical history and Reader State survive.
- [ ] Inspect sanitized traces for every distinct Reader request shape and any unexplained endpoint/parameter combination.

## Capture and freeze actual Reeder traffic

With `REEDER_TRACE=1`, collect only sanitized `reeder_request` events from the real-client run. Commit the final ordered shape fixture as:

`test/fixtures/reeder-v0.2-captured.json`

The fixture may include only sanitized request shape plus non-sensitive Reeder version, platform, and capture date metadata. It must contain none of:

- Authorization values or Reader/Admin credentials
- personal identity
- real Feed/article URLs
- raw item IDs
- personal folder names or custom titles
- raw continuation tokens
- article content or OPML bodies

Every distinct observed shape must map to an automated contract test, or the implementation/tests/docs must be reconciled before release.

## Final decision

The v0.2 gate passes only when:

- [ ] final `npm run check` and integration CI are green;
- [ ] the real-client checklist above is complete on the exact candidate commit;
- [ ] `test/fixtures/reeder-v0.2-captured.json` comes from that run and passes privacy inspection;
- [ ] every observed Reader request shape is covered or explicitly reconciled;
- [ ] discoverable icons, enclosure metadata, custom titles, state round-trips, and all three mark-all scopes work in real Reeder;
- [ ] the post-cutoff ingestion invariant is verified;
- [ ] `docs/reeder-compatibility.md` matches the observed surface;
- [ ] normal deployment is restored to `REEDER_TRACE=0`;
- [ ] no open correctness issue affects the supported v0.2 flow.

Until these boxes are complete, describe v0.2 as implementation-complete, not released.
