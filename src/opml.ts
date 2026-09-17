import { XMLParser } from "fast-xml-parser";
import { addFolderMembership, updateSubscription } from "./folder-store";
import { enqueueFeedRefresh } from "./refresh";
import { ensureSubscription } from "./store";

const MAX_OPML_BYTES = 1024 * 1024;
const MAX_OPML_FEEDS = 500;

export interface OpmlImportResult {
  feeds: number;
  folders: number;
  enqueued: number;
}

interface ImportFeed {
  url: string;
  title: string | null;
  folders: Set<string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

const outlineName = (outline: Record<string, unknown>): string =>
  text(outline["@_text"]) || text(outline["@_title"]);

const collectFeeds = (
  value: unknown,
  ancestors: string[],
  feeds: Map<string, ImportFeed>,
): void => {
  for (const raw of asArray(value)) {
    const outline = asRecord(raw);
    if (outline === null) continue;

    const xmlUrl = text(outline["@_xmlUrl"]);
    if (xmlUrl !== "") {
      let canonical: string;
      try {
        const url = new URL(xmlUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        url.hash = "";
        canonical = url.toString();
      } catch {
        continue;
      }

      const existing = feeds.get(canonical);
      const entry: ImportFeed = existing ?? {
        url: canonical,
        title: null,
        folders: new Set<string>(),
      };
      const title = outlineName(outline);
      if (entry.title === null && title !== "") entry.title = title;
      for (const ancestor of ancestors) entry.folders.add(ancestor);
      feeds.set(canonical, entry);
      if (feeds.size > MAX_OPML_FEEDS) throw new Error("OPML contains too many feeds");
      continue;
    }

    const name = outlineName(outline);
    const nextAncestors = name === "" ? ancestors : [...ancestors, name];
    collectFeeds(outline.outline, nextAncestors, feeds);
  }
};

export const parseOpml = (xml: string): ImportFeed[] => {
  if (new TextEncoder().encode(xml).byteLength > MAX_OPML_BYTES) {
    throw new Error("OPML exceeds 1 MiB limit");
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error("OPML DTD/entities are not supported");

  const root = asRecord(parser.parse(xml));
  const opml = asRecord(root?.opml);
  const body = asRecord(opml?.body);
  if (body === null) throw new Error("invalid OPML document");

  const feeds = new Map<string, ImportFeed>();
  collectFeeds(body.outline, [], feeds);
  return [...feeds.values()];
};

export const importOpml = async (
  env: Env,
  xml: string,
  now = Date.now(),
): Promise<OpmlImportResult> => {
  const feeds = parseOpml(xml);
  const folderNames = new Set<string>();
  let enqueued = 0;

  for (const feed of feeds) {
    const feedId = await ensureSubscription(env.DB, feed.url, now);
    if (feed.title !== null) {
      await updateSubscription(env.DB, feedId, { title: feed.title }, now);
    }
    for (const folder of feed.folders) {
      folderNames.add(folder);
      await addFolderMembership(env.DB, feedId, folder, now);
    }
    if ((await enqueueFeedRefresh(env, feedId, now)) === "enqueued") enqueued += 1;
  }

  return { feeds: feeds.length, folders: folderNames.size, enqueued };
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

interface ExportRow {
  feedId: number;
  url: string;
  title: string;
  folderName: string | null;
}

const feedOutline = (row: ExportRow): string =>
  `    <outline type="rss" text="${escapeXml(row.title)}" title="${escapeXml(row.title)}" xmlUrl="${escapeXml(row.url)}" />`;

export const exportOpml = async (db: D1Database): Promise<string> => {
  const result = await db
    .prepare(
      `SELECT f.id AS feedId,
              f.canonical_feed_url AS url,
              COALESCE(s.custom_title, NULLIF(f.title, ''), f.canonical_feed_url) AS title,
              folder.name AS folderName
       FROM subscriptions s
       JOIN feeds f ON f.id = s.feed_id
       LEFT JOIN subscription_folders sf ON sf.feed_id = s.feed_id
       LEFT JOIN folders folder ON folder.id = sf.folder_id
       WHERE s.active = 1
       ORDER BY folder.name COLLATE NOCASE, title COLLATE NOCASE, f.id`,
    )
    .all<ExportRow>();

  const byFolder = new Map<string, ExportRow[]>();
  const unfiled = new Map<number, ExportRow>();
  const feedsWithFolders = new Set<number>();
  for (const row of result.results) {
    if (row.folderName === null) {
      unfiled.set(row.feedId, row);
      continue;
    }
    feedsWithFolders.add(row.feedId);
    const rows = byFolder.get(row.folderName) ?? [];
    rows.push(row);
    byFolder.set(row.folderName, rows);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head><title>rss-sync-worker subscriptions</title></head>",
    "  <body>",
  ];

  for (const [folder, rows] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    <outline text="${escapeXml(folder)}" title="${escapeXml(folder)}">`);
    for (const row of rows) lines.push(`  ${feedOutline(row)}`);
    lines.push("    </outline>");
  }
  for (const row of unfiled.values()) {
    if (!feedsWithFolders.has(row.feedId)) lines.push(feedOutline(row));
  }

  lines.push("  </body>", "</opml>", "");
  return lines.join("\n");
};
