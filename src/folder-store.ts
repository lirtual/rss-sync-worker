export interface FolderView {
  id: number;
  name: string;
}

export interface SubscriptionFolderView {
  feedId: number;
  folderId: number;
  name: string;
}

const normalizeFolderName = (name: string): string => {
  const normalized = name.trim();
  if (normalized === "" || normalized.length > 512) throw new Error("invalid folder name");
  return normalized;
};

export const listFolders = async (db: D1Database): Promise<FolderView[]> => {
  const result = await db
    .prepare("SELECT id, name FROM folders ORDER BY name COLLATE NOCASE, id")
    .all<FolderView>();
  return result.results;
};

export const listSubscriptionFolders = async (
  db: D1Database,
): Promise<SubscriptionFolderView[]> => {
  const result = await db
    .prepare(
      `SELECT sf.feed_id AS feedId, f.id AS folderId, f.name
       FROM subscription_folders sf
       JOIN folders f ON f.id = sf.folder_id
       JOIN subscriptions s ON s.feed_id = sf.feed_id AND s.active = 1
       ORDER BY sf.feed_id, f.name COLLATE NOCASE, f.id`,
    )
    .all<SubscriptionFolderView>();
  return result.results;
};

export const findFolderByName = async (
  db: D1Database,
  name: string,
): Promise<FolderView | null> =>
  db
    .prepare("SELECT id, name FROM folders WHERE name = ? COLLATE NOCASE")
    .bind(normalizeFolderName(name))
    .first<FolderView>();

export const ensureFolder = async (
  db: D1Database,
  name: string,
  now: number,
): Promise<FolderView> => {
  const normalized = normalizeFolderName(name);
  await db
    .prepare(
      `INSERT INTO folders (name, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(name COLLATE NOCASE) DO NOTHING`,
    )
    .bind(normalized, now, now)
    .run();

  const folder = await findFolderByName(db, normalized);
  if (folder === null) throw new Error("failed to create folder");
  return folder;
};

export const addFolderMembership = async (
  db: D1Database,
  feedId: number,
  folderName: string,
  now: number,
): Promise<void> => {
  const folder = await ensureFolder(db, folderName, now);
  await db
    .prepare(
      `INSERT INTO subscription_folders (feed_id, folder_id)
       SELECT ?, ?
       WHERE EXISTS (SELECT 1 FROM subscriptions WHERE feed_id = ?)
       ON CONFLICT(feed_id, folder_id) DO NOTHING`,
    )
    .bind(feedId, folder.id, feedId)
    .run();
};

export const removeFolderMembership = async (
  db: D1Database,
  feedId: number,
  folderName: string,
): Promise<void> => {
  const folder = await findFolderByName(db, folderName);
  if (folder === null) return;
  await db
    .prepare("DELETE FROM subscription_folders WHERE feed_id = ? AND folder_id = ?")
    .bind(feedId, folder.id)
    .run();
};

export const renameFolder = async (
  db: D1Database,
  oldName: string,
  newName: string,
  now: number,
): Promise<void> => {
  const source = await findFolderByName(db, oldName);
  if (source === null) return;
  const normalized = normalizeFolderName(newName);
  const destination = await findFolderByName(db, normalized);

  if (destination !== null && destination.id !== source.id) {
    await db
      .prepare(
        `INSERT INTO subscription_folders (feed_id, folder_id)
         SELECT feed_id, ? FROM subscription_folders WHERE folder_id = ?
         ON CONFLICT(feed_id, folder_id) DO NOTHING`,
      )
      .bind(destination.id, source.id)
      .run();
    await db.prepare("DELETE FROM folders WHERE id = ?").bind(source.id).run();
    return;
  }

  await db
    .prepare("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?")
    .bind(normalized, now, source.id)
    .run();
};

export const deleteFolder = async (db: D1Database, name: string): Promise<void> => {
  const folder = await findFolderByName(db, name);
  if (folder === null) return;
  await db.prepare("DELETE FROM folders WHERE id = ?").bind(folder.id).run();
};

export const updateSubscription = async (
  db: D1Database,
  feedId: number,
  changes: { active?: boolean; title?: string | null },
  now: number,
): Promise<boolean> => {
  const existing = await db
    .prepare("SELECT feed_id AS feedId FROM subscriptions WHERE feed_id = ?")
    .bind(feedId)
    .first<{ feedId: number }>();
  if (existing === null) return false;

  if (changes.active !== undefined) {
    await db
      .prepare("UPDATE subscriptions SET active = ?, updated_at = ? WHERE feed_id = ?")
      .bind(changes.active ? 1 : 0, now, feedId)
      .run();
  }
  if (changes.title !== undefined) {
    const title = changes.title === null || changes.title.trim() === "" ? null : changes.title.trim();
    await db
      .prepare("UPDATE subscriptions SET custom_title = ?, updated_at = ? WHERE feed_id = ?")
      .bind(title, now, feedId)
      .run();
  }
  return true;
};
