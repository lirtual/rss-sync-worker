export type MarkAllScope =
  | { kind: "reading-list" }
  | { kind: "feed"; feedId: number }
  | { kind: "folder"; folderName: string };

export const markStreamRead = async (
  db: D1Database,
  scope: MarkAllScope,
  cutoffMs: number,
  changedAt: number,
): Promise<number> => {
  const conditions = ["s.active = 1", "COALESCE(e.published_at, e.ingested_at) <= ?"];
  const bindings: Array<string | number> = [cutoffMs];
  let folderJoin = "";

  if (scope.kind === "feed") {
    conditions.push("e.feed_id = ?");
    bindings.push(scope.feedId);
  } else if (scope.kind === "folder") {
    folderJoin = `
       JOIN subscription_folders sf ON sf.feed_id = e.feed_id
       JOIN folders folder ON folder.id = sf.folder_id`;
    conditions.push("folder.name = ? COLLATE NOCASE");
    bindings.push(scope.folderName);
  }

  const result = await db
    .prepare(
      `UPDATE entry_states
       SET is_read = 1, read_changed_at = ?, updated_at = ?
       WHERE is_read = 0
         AND entry_id IN (
           SELECT e.id
           FROM entries e
           JOIN subscriptions s ON s.feed_id = e.feed_id${folderJoin}
           WHERE ${conditions.join(" AND ")}
         )`,
    )
    .bind(changedAt, changedAt, ...bindings)
    .run();
  return result.meta.changes ?? 0;
};
