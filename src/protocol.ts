const GOOGLE_ITEM_PREFIX = "tag:google.com,2005:reader/item/";

export interface ReaderEntry {
  id: number;
  feedId: number;
  feedTitle: string;
  feedSiteUrl: string | null;
  folderNames: string[];
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: number | null;
  sourceUpdatedAt: number | null;
  ingestedAt: number;
  updatedAt: number;
  contentHtml: string;
  isRead: number;
  isStarred: number;
}

export interface StreamCursor {
  ingestedAt: number;
  id: number;
}

export const parseItemId = (value: string): number | null => {
  let candidate = value.trim();
  let radix = 10;

  if (candidate.startsWith(GOOGLE_ITEM_PREFIX)) {
    candidate = candidate.slice(GOOGLE_ITEM_PREFIX.length);
    radix = 16;
  } else if (/^0x[0-9a-f]+$/iu.test(candidate)) {
    candidate = candidate.slice(2);
    radix = 16;
  } else if (/^[0-9a-f]{16}$/iu.test(candidate)) {
    radix = 16;
  } else if (/^[0-9a-f]*[a-f][0-9a-f]*$/iu.test(candidate)) {
    radix = 16;
  }

  if (
    candidate.length === 0 ||
    (radix === 10 ? !/^\d+$/u.test(candidate) : !/^[0-9a-f]+$/iu.test(candidate))
  ) {
    return null;
  }

  const parsed = Number.parseInt(candidate, radix);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const googleItemTag = (id: number): string =>
  `${GOOGLE_ITEM_PREFIX}${id.toString(16).padStart(16, "0")}`;

export const encodeContinuation = (cursor: StreamCursor): string => {
  const json = JSON.stringify([cursor.ingestedAt, cursor.id]);
  return btoa(json).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

export const decodeContinuation = (value: string | null): StreamCursor | null => {
  if (value === null || value === "") return null;
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(normalized + padding));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ingestedAt, id] = parsed;
    if (
      typeof ingestedAt !== "number" ||
      typeof id !== "number" ||
      !Number.isSafeInteger(ingestedAt) ||
      !Number.isSafeInteger(id) ||
      ingestedAt < 0 ||
      id <= 0
    ) {
      return null;
    }
    return { ingestedAt, id };
  } catch {
    return null;
  }
};

export const googleEntry = (entry: ReaderEntry) => {
  const categories = ["user/-/state/com.google/reading-list"];
  if (entry.isRead === 1) categories.push("user/-/state/com.google/read");
  if (entry.isStarred === 1) categories.push("user/-/state/com.google/starred");
  for (const folderName of entry.folderNames) categories.push(`user/-/label/${folderName}`);

  const publishedAt = entry.publishedAt ?? entry.ingestedAt;
  const alternate = entry.url === null ? [] : [{ href: entry.url, type: "text/html" }];
  const canonical = entry.url === null ? [] : [{ href: entry.url }];

  return {
    id: googleItemTag(entry.id),
    title: entry.title,
    timestampUsec: String(publishedAt * 1_000),
    crawlTimeMsec: String(entry.ingestedAt),
    published: Math.floor(publishedAt / 1_000),
    updated: Math.floor((entry.sourceUpdatedAt ?? entry.updatedAt) / 1_000),
    alternate,
    canonical,
    content: { direction: "ltr", content: entry.contentHtml },
    summary: { direction: "ltr", content: entry.contentHtml },
    origin: {
      streamId: `feed/${entry.feedId}`,
      title: entry.feedTitle,
      ...(entry.feedSiteUrl === null || entry.feedSiteUrl === ""
        ? {}
        : { htmlUrl: entry.feedSiteUrl }),
    },
    categories,
    ...(entry.author === null || entry.author === "" ? {} : { author: entry.author }),
  };
};
