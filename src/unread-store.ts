export interface UnreadCountRow {
  id: string;
  count: number;
  newestItemTimestampUsec: string;
}

interface AggregateRow {
  count: number | null;
  newest: number | null;
}

interface FeedAggregateRow extends AggregateRow {
  feedId: number;
}

interface FolderAggregateRow extends AggregateRow {
  folderName: string;
}

const toUnreadCount = (id: string, row: AggregateRow): UnreadCountRow => ({
  id,
  count: Number(row.count ?? 0),
  newestItemTimestampUsec: String(Math.max(0, Number(row.newest ?? 0)) * 1_000),
});

// Keep the unread predicate explicit so D1 can use the entry_states_unread index.
export const listUnreadCounts = async (
  db: D1Database,
  readingListStream: string,
  labelId: (name: string) => string,
): Promise<UnreadCountRow[]> => {
  const [globalResult, feedResult, folderResult] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(MAX(e.ingested_at), 0) AS newest
         FROM entry_states es
         JOIN entries e ON e.id = es.entry_id
         JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1
         WHERE es.is_read = 0`,
      )
      .first<AggregateRow>(),
    db
      .prepare(
        `SELECT e.feed_id AS feedId, COUNT(*) AS count, MAX(e.ingested_at) AS newest
         FROM entry_states es
         JOIN entries e ON e.id = es.entry_id
         JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1
         WHERE es.is_read = 0
         GROUP BY e.feed_id
         ORDER BY e.feed_id`,
      )
      .all<FeedAggregateRow>(),
    db
      .prepare(
        `SELECT folder.name AS folderName, COUNT(*) AS count, MAX(e.ingested_at) AS newest
         FROM entry_states es
         JOIN entries e ON e.id = es.entry_id
         JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1
         JOIN subscription_folders sf ON sf.feed_id = s.feed_id
         JOIN folders folder ON folder.id = sf.folder_id
         WHERE es.is_read = 0
         GROUP BY folder.id, folder.name
         ORDER BY folder.name`,
      )
      .all<FolderAggregateRow>(),
  ]);

  return [
    toUnreadCount(readingListStream, globalResult ?? { count: 0, newest: 0 }),
    ...feedResult.results.map((row) => toUnreadCount(`feed/${row.feedId}`, row)),
    ...folderResult.results.map((row) => toUnreadCount(labelId(row.folderName), row)),
  ];
};
