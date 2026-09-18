export interface ReaderStateMutation {
  isRead?: boolean;
  isStarred?: boolean;
}

export const mutateEntryStates = async (
  db: D1Database,
  entryIds: number[],
  mutation: ReaderStateMutation,
  now: number,
): Promise<number> => {
  if (entryIds.length === 0) return 0;
  if (mutation.isRead === undefined && mutation.isStarred === undefined) return 0;

  const placeholders = entryIds.map(() => "?").join(", ");
  const setClauses = ["updated_at = ?"];
  const bindings: Array<number> = [now];

  if (mutation.isRead !== undefined) {
    setClauses.push("is_read = ?", "read_changed_at = ?");
    bindings.push(mutation.isRead ? 1 : 0, now);
  }
  if (mutation.isStarred !== undefined) {
    setClauses.push("is_starred = ?", "starred_changed_at = ?");
    bindings.push(mutation.isStarred ? 1 : 0, now);
  }

  bindings.push(...entryIds);
  const result = await db
    .prepare(
      `UPDATE entry_states
       SET ${setClauses.join(", ")}
       WHERE entry_id IN (${placeholders})
         AND entry_id IN (
           SELECT e.id
           FROM entries e
           JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1
         )`,
    )
    .bind(...bindings)
    .run();
  return result.meta.changes ?? 0;
};
