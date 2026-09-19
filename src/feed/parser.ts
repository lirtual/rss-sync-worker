import { XMLParser } from "fast-xml-parser";

export interface ParsedEnclosure {
  url: string;
  mimeType: string | null;
  lengthBytes: number | null;
  title: string | null;
}

export interface ParsedEntry {
  sourceId: string | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: number | null;
  sourceUpdatedAt: number | null;
  contentHtml: string;
  enclosures: ParsedEnclosure[];
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  iconUrls: string[];
  entries: ParsedEntry[];
}

const MAX_PARSED_ENTRIES = 250;
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

const positiveInteger = (value: unknown): number | null => {
  const candidate = typeof value === "number" ? value : Number(text(value));
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
};

const iconList = (...values: unknown[]): string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = text(value);
    if (candidate !== "") seen.add(candidate);
  }
  return [...seen];
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

const rssEnclosures = (value: unknown): ParsedEnclosure[] =>
  asArray(value).flatMap((raw) => {
    const enclosure = asRecord(raw);
    if (enclosure === null) return [];
    const url = text(enclosure["@_url"]);
    if (url === "") return [];
    return [
      {
        url,
        mimeType: text(enclosure["@_type"]) || null,
        lengthBytes: positiveInteger(enclosure["@_length"]),
        title: text(enclosure["@_title"]) || null,
      },
    ];
  });

const atomEnclosures = (value: unknown): ParsedEnclosure[] =>
  asArray(value).flatMap((raw) => {
    const link = asRecord(raw);
    if (link === null || text(link["@_rel"]) !== "enclosure") return [];
    const url = text(link["@_href"]);
    if (url === "") return [];
    return [
      {
        url,
        mimeType: text(link["@_type"]) || null,
        lengthBytes: positiveInteger(link["@_length"]),
        title: text(link["@_title"]) || null,
      },
    ];
  });

const parseRssEntry = (raw: unknown): ParsedEntry => {
  const item = asRecord(raw) ?? {};
  return {
    sourceId: text(item.guid) || null,
    title: text(item.title),
    url: text(item.link) || null,
    author: text(item.author) || text(item["dc:creator"]) || null,
    publishedAt: dateMs(item.pubDate ?? item["dc:date"]),
    sourceUpdatedAt: dateMs(item.updated ?? item["atom:updated"]),
    contentHtml: text(item["content:encoded"]) || text(item.description),
    enclosures: rssEnclosures(item.enclosure),
  };
};

const parseRss = (root: Record<string, unknown>): ParsedFeed | null => {
  const rss = asRecord(root.rss);
  const channel = asRecord(rss?.channel);
  if (channel === null) return null;
  const image = asRecord(channel.image);

  return {
    title: text(channel.title) || "Untitled feed",
    siteUrl: text(channel.link) || null,
    iconUrls: iconList(image?.url),
    entries: asArray(channel.item).slice(0, MAX_PARSED_ENTRIES).map(parseRssEntry),
  };
};

const parseRdf = (root: Record<string, unknown>): ParsedFeed | null => {
  const rdf = asRecord(root["rdf:RDF"] ?? root.RDF);
  if (rdf === null) return null;
  const channel = asRecord(rdf.channel);
  if (channel === null) return null;
  const image = asRecord(channel.image);

  return {
    title: text(channel.title) || "Untitled feed",
    siteUrl: text(channel.link) || null,
    iconUrls: iconList(image?.url),
    entries: asArray(rdf.item)
      .slice(0, MAX_PARSED_ENTRIES)
      .map((raw): ParsedEntry => {
        const item = asRecord(raw) ?? {};
        return {
          sourceId: text(item["rdf:about"]) || text(item["@_rdf:about"]) || null,
          title: text(item.title),
          url: text(item.link) || null,
          author: text(item["dc:creator"]) || null,
          publishedAt: dateMs(item["dc:date"]),
          sourceUpdatedAt: dateMs(item["dc:date"]),
          contentHtml: text(item["content:encoded"]) || text(item.description),
          enclosures: rssEnclosures(item.enclosure),
        };
      }),
  };
};

const parseAtom = (root: Record<string, unknown>): ParsedFeed | null => {
  const feed = asRecord(root.feed);
  if (feed === null) return null;

  return {
    title: text(feed.title) || "Untitled feed",
    siteUrl: atomLink(feed.link),
    iconUrls: iconList(feed.icon, feed.logo),
    entries: asArray(feed.entry)
      .slice(0, MAX_PARSED_ENTRIES)
      .map((raw): ParsedEntry => {
        const entry = asRecord(raw) ?? {};
        return {
          sourceId: text(entry.id) || null,
          title: text(entry.title),
          url: atomLink(entry.link),
          author: atomAuthor(entry.author),
          publishedAt: dateMs(entry.published ?? entry.issued ?? entry.created ?? entry.updated),
          sourceUpdatedAt: dateMs(entry.updated ?? entry.modified),
          contentHtml: text(entry.content) || text(entry.summary),
          enclosures: atomEnclosures(entry.link),
        };
      }),
  };
};

const jsonString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const jsonAuthor = (item: Record<string, unknown>): string | null => {
  const authors = asArray(item.authors);
  const first = asRecord(authors[0]) ?? asRecord(item.author);
  return jsonString(first?.name) ?? null;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const jsonContent = (item: Record<string, unknown>): string => {
  const html = jsonString(item.content_html);
  if (html !== null) return html;
  const plain = jsonString(item.content_text) ?? jsonString(item.summary);
  return plain === null ? "" : `<p>${escapeHtml(plain)}</p>`;
};

const jsonEnclosures = (value: unknown): ParsedEnclosure[] =>
  asArray(value).flatMap((raw) => {
    const attachment = asRecord(raw);
    if (attachment === null) return [];
    const url = jsonString(attachment.url);
    if (url === null) return [];
    return [
      {
        url,
        mimeType: jsonString(attachment.mime_type),
        lengthBytes: positiveInteger(attachment.size_in_bytes),
        title: jsonString(attachment.title),
      },
    ];
  });

const parseJsonFeed = (document: string): ParsedFeed | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new Error("feed document is not valid JSON");
  }
  const feed = asRecord(parsed);
  if (feed === null) return null;
  const version = jsonString(feed.version);
  if (
    version !== "https://jsonfeed.org/version/1" &&
    version !== "https://jsonfeed.org/version/1.1"
  ) {
    return null;
  }

  return {
    title: jsonString(feed.title) ?? "Untitled feed",
    siteUrl: jsonString(feed.home_page_url),
    iconUrls: iconList(feed.icon, feed.favicon),
    entries: asArray(feed.items)
      .slice(0, MAX_PARSED_ENTRIES)
      .map((raw): ParsedEntry => {
        const item = asRecord(raw) ?? {};
        return {
          sourceId: jsonString(item.id),
          title: jsonString(item.title) ?? "",
          url: jsonString(item.url) ?? jsonString(item.external_url),
          author: jsonAuthor(item),
          publishedAt: dateMs(item.date_published),
          sourceUpdatedAt: dateMs(item.date_modified),
          contentHtml: jsonContent(item),
          enclosures: jsonEnclosures(item.attachments),
        };
      }),
  };
};

export const parseFeed = (document: string): ParsedFeed => {
  const trimmed = document.trimStart();
  if (trimmed.startsWith("{")) {
    const jsonFeed = parseJsonFeed(document);
    if (jsonFeed !== null) return jsonFeed;
    throw new Error("unsupported JSON feed format");
  }

  if (/<!DOCTYPE|<!ENTITY/iu.test(document)) {
    throw new Error("feed XML declarations with DTD/entities are not supported");
  }

  const root = asRecord(parser.parse(document));
  if (root === null) throw new Error("feed document is not XML data");

  const rss = parseRss(root);
  if (rss !== null) return rss;

  const rdf = parseRdf(root);
  if (rdf !== null) return rdf;

  const atom = parseAtom(root);
  if (atom !== null) return atom;

  throw new Error("unsupported feed format");
};
