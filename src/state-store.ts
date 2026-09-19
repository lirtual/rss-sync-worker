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
  const bindings: number[] = [now];
  const changedClauses: string[] = [];
  const changedBindings: number[] = [];

  if (mutation.isRead !== undefined) {
    const value = mutation.isRead ? 1 : 0;
    setClauses.push(
      "is_read = ?",
      "read_changed_at = CASE WHEN is_read <> ? THEN ? ELSE read_changed_at END",
    );
    bindings.push(value, value, now);
    changedClauses.push("is_read <> ?");
    changedBindings.push(value);
  }
  if (mutation.isStarred !== undefined) {
    const value = mutation.isStarred ? 1 : 0;
    setClauses.push(
      "is_starred = ?",
      "starred_changed_at = CASE WHEN is_starred <> ? THEN ? ELSE starred_changed_at END",
    );
    bindings.push(value, value, now);
    changedClauses.push("is_starred <> ?");
    changedBindings.push(value);
  }

  const result = await db
    .prepare(
      `UPDATE entry_states
       SET ${setClauses.join(", ")}
       WHERE entry_id IN (${placeholders})
         AND entry_id IN (
           SELECT e.id
           FROM entries e
           JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1
         )
         AND (${changedClauses.join(" OR ")})`,
    )
    .bind(...bindings, ...entryIds, ...changedBindings)
    .run();
  return result.meta.changes ?? 0;
};
