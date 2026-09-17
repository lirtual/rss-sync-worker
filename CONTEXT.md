# Domain Context

This document defines the canonical domain language for `rss-sync-worker`. It intentionally contains no framework, database, or deployment details.

## Purpose

The product is an RSS synchronization service used by a reader client. It is not itself a reading application.

## Terms

### Feed
A remote syndication source that publishes Entries. A Feed has a stable logical identity even if its retrieval URL later changes.

### Subscription
The user's current relationship to a Feed. A Subscription may be active or inactive. Removing a Subscription does not imply deleting the Feed or its historical Entries.

### Entry
One logical article or item published by a Feed. An Entry keeps the same identity when the publisher edits its title, content, metadata, or URL.

### Reading List
The aggregate stream of Entries from all active Subscriptions.

### Folder
A user-visible grouping of Subscriptions exposed to the reader client. A Subscription may belong to more than one Folder.

### Stream
A selectable set of Entries, such as the Reading List, one Feed, one Folder, starred Entries, or unread Entries.

### Reader State
User-owned state attached to an Entry. v0.1 Reader State consists of read/unread and starred/unstarred. Publisher changes to an Entry must not alter Reader State.

### Bootstrap
The first successful population of Entries for a newly subscribed Feed. Bootstrap Entries are historical context rather than newly delivered unread content.

### Ingestion Order
The service-owned ordering that represents when Entries became known to the service. Ingestion Order, not publisher-supplied publication time, defines bulk-read cutoff behavior.

### Mark All As Read
A Stream-level operation that marks every Entry in the selected Stream at or before a supplied cutoff as read. It is not a loop over the client's currently loaded page.

### Entry Identity
The stable logical identity used to recognize the same Entry across repeated Feed fetches and publisher edits.

### Feed Identity
The stable logical identity of a Feed across redirects, resubscriptions, and URL changes.

### Supported Protocol Surface
The subset of synchronization protocol behavior that is explicitly supported and verified for the target reader client. Protocol support is defined by tested behavior, not by claiming complete compatibility with every endpoint of the historical protocol.

## Domain invariants

1. A Feed's logical identity survives URL changes.
2. An Entry's logical identity survives publisher edits.
3. Re-observing the same Entry never creates a second logical Entry.
4. Publisher changes never reset Reader State.
5. Removing a Subscription does not implicitly erase historical Entries or starred state.
6. An Entry disappearing from a remote Feed does not mean the Entry was deleted.
7. Bootstrap history is not treated as newly delivered unread content.
8. Mark All As Read applies to the complete selected Stream within its cutoff, independent of client pagination.
9. Entries first ingested after a bulk-read cutoff remain unread even if their publisher-supplied publication date is older.
10. Repeated equivalent reader mutations are safe and do not produce divergent state.
