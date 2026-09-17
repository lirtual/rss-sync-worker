import { XMLParser } from "fast-xml-parser";

export interface ParsedEntry {
  sourceId: string | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: number | null;
  sourceUpdatedAt: number | null;
  contentHtml: string;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  entries: ParsedEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
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

const text = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  if (record === null) return "";
  const direct = record["#text"] ?? record["#cdata"];
  if (typeof direct === "string") return direct.trim();
  return "";
};

const dateMs = (value: unknown): number | null => {
  const candidate = text(value);
  if (candidate === "") return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const atomLink = (value: unknown): string | null => {
  for (const item of asArray(value)) {
    const record = asRecord(item);
    if (record === null) {
      const candidate = text(item);
      if (candidate !== "") return candidate;
      continue;
    }
    const href = text(record["@_href"]);
    const rel = text(record["@_rel"]);
    if (href !== "" && (rel === "" || rel === "alternate")) return href;
  }
  return null;
};

const atomAuthor = (value: unknown): string | null => {
  const record = asRecord(Array.isArray(value) ? value[0] : value);
  const name = record === null ? text(value) : text(record.name);
  return name === "" ? null : name;
};

const parseRss = (root: Record<string, unknown>): ParsedFeed | null => {
  const rss = asRecord(root.rss);
  const channel = asRecord(rss?.channel);
  if (channel === null) return null;

  const entries = asArray(channel.item).map((raw): ParsedEntry => {
    const item = asRecord(raw) ?? {};
    const sourceId = text(item.guid) || null;
    const url = text(item.link) || null;
    const title = text(item.title);
    const author = text(item.author) || text(item["dc:creator"]) || null;
    const publishedAt = dateMs(item.pubDate ?? item["dc:date"]);
    const sourceUpdatedAt = dateMs(item.updated ?? item["atom:updated"]);
    const contentHtml = text(item["content:encoded"]) || text(item.description);
    return {
      sourceId,
      title,
      url,
      author,
      publishedAt,
      sourceUpdatedAt,
      contentHtml,
    };
  });

  return {
    title: text(channel.title) || "Untitled feed",
    siteUrl: text(channel.link) || null,
    entries,
  };
};

const parseAtom = (root: Record<string, unknown>): ParsedFeed | null => {
  const feed = asRecord(root.feed);
  if (feed === null) return null;

  const entries = asArray(feed.entry).map((raw): ParsedEntry => {
    const entry = asRecord(raw) ?? {};
    const sourceId = text(entry.id) || null;
    const url = atomLink(entry.link);
    const title = text(entry.title);
    const author = atomAuthor(entry.author);
    const publishedAt = dateMs(entry.published ?? entry.updated);
    const sourceUpdatedAt = dateMs(entry.updated);
    const contentHtml = text(entry.content) || text(entry.summary);
    return {
      sourceId,
      title,
      url,
      author,
      publishedAt,
      sourceUpdatedAt,
      contentHtml,
    };
  });

  return {
    title: text(feed.title) || "Untitled feed",
    siteUrl: atomLink(feed.link),
    entries,
  };
};

export const parseFeed = (xml: string): ParsedFeed => {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new Error("feed XML declarations with DTD/entities are not supported");
  }

  const root = asRecord(parser.parse(xml));
  if (root === null) throw new Error("feed document is not XML data");

  const rss = parseRss(root);
  if (rss !== null) return rss;

  const atom = parseAtom(root);
  if (atom !== null) return atom;

  throw new Error("unsupported feed format: expected RSS 2.0 or Atom 1.0");
};
