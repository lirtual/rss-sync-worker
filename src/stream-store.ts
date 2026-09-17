import type { ReaderEntry, StreamCursor } from "./protocol";

export interface StreamFilter {
  feedId: number | null;
  unreadOnly: boolean;
  starredOnly: boolean;
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
  const bindings: Array<number> = [];

  if (filter.feedId !== null) {
    conditions.push("e.feed_id = ?");
    bindings.push(filter.feedId);
  }
  if (filter.unreadOnly) conditions.push("es.is_read = 0");
  if (filter.starredOnly) conditions.push("es.is_starred = 1");
  if (cursor !== null) {
    conditions.push("(e.ingested_at < ? OR (e.ingested_at = ? AND e.id < ?))");
    bindings.push(cursor.ingestedAt, cursor.ingestedAt, cursor.id);
  }

  bindings.push(limit + 1);
  const result = await db
    .prepare(
      `SELECT e.id, e.ingested_at AS ingestedAt
       FROM entries e
       JOIN subscriptions s ON s.feed_id = e.feed_id
       JOIN entry_states es ON es.entry_id = e.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.ingested_at DESC, e.id DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<StreamItemRef>();

  const hasMore = result.results.length > limit;
  return { items: result.results.slice(0, limit), hasMore };
};

export const findReaderEntries = async (
  db: D1Database,
  ids: number[],
): Promise<ReaderEntry[]> => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT e.id,
              e.feed_id AS feedId,
              COALESCE(NULLIF(f.title, ''), f.canonical_feed_url) AS feedTitle,
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
    .all<ReaderEntry>();

  const byId = new Map(result.results.map((entry) => [entry.id, entry]));
  return ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry === undefined ? [] : [entry];
  });
};
