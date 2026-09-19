import type { ReaderEntry, StreamCursor } from "./protocol";

export interface StreamFilter {
  feedId: number | null;
  folderName: string | null;
  unreadOnly: boolean;
  readOnly: boolean;
  starredOnly: boolean;
  unstarredOnly: boolean;
  afterTime: number | null;
  beforeTime: number | null;
  sortOldestFirst: boolean;
}

export interface StreamItemRef {
  id: number;
  ingestedAt: number;
}

export interface StreamPage {
  items: StreamItemRef[];
  hasMore: boolean;
}

export const listStreamItemIds = async (
  db: D1Database,
  filter: StreamFilter,
  cursor: StreamCursor | null,
  limit: number,
): Promise<StreamPage> => {
  const conditions = ["s.active = 1"];
  const bindings: Array<string | number> = [];
  let folderJoin = "";

  if (filter.feedId !== null) {
    conditions.push("e.feed_id = ?");
    bindings.push(filter.feedId);
  }
  if (filter.folderName !== null) {
    folderJoin = `
       JOIN subscription_folders sf ON sf.feed_id = e.feed_id
       JOIN folders folder ON folder.id = sf.folder_id`;
    conditions.push("folder.name = ? COLLATE NOCASE");
    bindings.push(filter.folderName);
  }
  if (filter.unreadOnly) conditions.push("es.is_read = 0");
  if (filter.readOnly) conditions.push("es.is_read = 1");
  if (filter.starredOnly) conditions.push("es.is_starred = 1");
  if (filter.unstarredOnly) conditions.push("es.is_starred = 0");
  if (filter.afterTime !== null) {
    if (filter.readOnly) {
      conditions.push(
        "(COALESCE(e.published_at, e.ingested_at) >= ? OR COALESCE(es.read_changed_at, 0) >= ?)",
      );
      bindings.push(filter.afterTime, filter.afterTime);
    } else {
      conditions.push("COALESCE(e.published_at, e.ingested_at) >= ?");
      bindings.push(filter.afterTime);
    }
  }
  if (filter.beforeTime !== null) {
    conditions.push("COALESCE(e.published_at, e.ingested_at) <= ?");
    bindings.push(filter.beforeTime);
  }
  if (cursor !== null) {
    conditions.push(
      filter.sortOldestFirst
        ? "(e.ingested_at > ? OR (e.ingested_at = ? AND e.id > ?))"
        : "(e.ingested_at < ? OR (e.ingested_at = ? AND e.id < ?))",
    );
    bindings.push(cursor.ingestedAt, cursor.ingestedAt, cursor.id);
  }

  bindings.push(limit + 1);
  const direction = filter.sortOldestFirst ? "ASC" : "DESC";
  const result = await db
    .prepare(
      `SELECT e.id, e.ingested_at AS ingestedAt
       FROM entries e
       JOIN subscriptions s ON s.feed_id = e.feed_id
       JOIN entry_states es ON es.entry_id = e.id${folderJoin}
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.ingested_at ${direction}, e.id ${direction}
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<StreamItemRef>();

  const hasMore = result.results.length > limit;
  return { items: result.results.slice(0, limit), hasMore };
};

type ReaderEntryRow = Omit<ReaderEntry, "folderNames" | "enclosures">;

interface FeedFolderRow {
  feedId: number;
  folderName: string;
}

interface EntryEnclosureRow {
  entryId: number;
  url: string;
  mimeType: string | null;
  lengthBytes: number | null;
  title: string | null;
}

export const findReaderEntries = async (db: D1Database, ids: number[]): Promise<ReaderEntry[]> => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT e.id,
              e.feed_id AS feedId,
              COALESCE(NULLIF(f.title, ''), f.canonical_feed_url) AS feedTitle,
              f.site_url AS feedSiteUrl,
              e.title,
              e.url,
              e.author,
              e.published_at AS publishedAt,
              e.source_updated_at AS sourceUpdatedAt,
              e.ingested_at AS ingestedAt,
              e.updated_at AS updatedAt,
              COALESCE(ec.content_html, '') AS contentHtml,
              es.is_read AS isRead,
              es.is_starred AS isStarred
       FROM entries e
       JOIN feeds f ON f.id = e.feed_id
       JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1
       JOIN entry_states es ON es.entry_id = e.id
       LEFT JOIN entry_contents ec ON ec.entry_id = e.id
       WHERE e.id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<ReaderEntryRow>();

  const entryIds = result.results.map((entry) => entry.id);
  const enclosuresByEntry = new Map<number, EntryEnclosureRow[]>();
  if (entryIds.length > 0) {
    const entryPlaceholders = entryIds.map(() => "?").join(", ");
    const enclosureResult = await db
      .prepare(
        `SELECT entry_id AS entryId,
                url,
                mime_type AS mimeType,
                length_bytes AS lengthBytes,
                title
         FROM entry_enclosures
         WHERE entry_id IN (${entryPlaceholders})
         ORDER BY entry_id, position`,
      )
      .bind(...entryIds)
      .all<EntryEnclosureRow>();
    for (const enclosure of enclosureResult.results) {
      const values = enclosuresByEntry.get(enclosure.entryId) ?? [];
      values.push(enclosure);
      enclosuresByEntry.set(enclosure.entryId, values);
    }
  }

  const feedIds = [...new Set(result.results.map((entry) => entry.feedId))];
  const foldersByFeed = new Map<number, string[]>();
  if (feedIds.length > 0) {
    const feedPlaceholders = feedIds.map(() => "?").join(", ");
    const folderResult = await db
      .prepare(
        `SELECT sf.feed_id AS feedId, folder.name AS folderName
         FROM subscription_folders sf
         JOIN folders folder ON folder.id = sf.folder_id
         JOIN subscriptions s ON s.feed_id = sf.feed_id AND s.active = 1
         WHERE sf.feed_id IN (${feedPlaceholders})
         ORDER BY sf.feed_id, folder.name COLLATE NOCASE, folder.id`,
      )
      .bind(...feedIds)
      .all<FeedFolderRow>();
    for (const row of folderResult.results) {
      const names = foldersByFeed.get(row.feedId) ?? [];
      names.push(row.folderName);
      foldersByFeed.set(row.feedId, names);
    }
  }

  const byId = new Map(
    result.results.map((entry) => [
      entry.id,
      {
        ...entry,
        folderNames: foldersByFeed.get(entry.feedId) ?? [],
        enclosures: enclosuresByEntry.get(entry.id) ?? [],
      },
    ]),
  );
  return ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry === undefined ? [] : [entry];
  });
};
