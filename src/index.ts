import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  addFolderMembership,
  deleteFolder,
  listFolders,
  listSubscriptionFolders,
  removeFolderMembership,
  renameFolder,
  updateSubscription,
} from "./folder-store";
import { type MarkAllScope, markStreamRead } from "./mark-all-store";
import { decodeContinuation, encodeContinuation, googleEntry, parseItemId } from "./protocol";
import { normalizeReaderStream, readerCredential, readerParams } from "./reader-request";
import { dispatchDueFeeds, enqueueFeedRefresh, processRefreshMessage } from "./refresh";
import { mutateEntryStates } from "./state-store";
import { ensureSubscription, listSubscriptions } from "./store";
import { findReaderEntries, listStreamItemIds, type StreamFilter } from "./stream-store";
import { listUnreadCounts } from "./unread-store";

type AppBindings = {
  Bindings: Env;
  Variables: {
    readerParams: URLSearchParams;
  };
};

const app = new Hono<AppBindings>();
const readerRoot = "/api/reader/reader/api/0";
const readingListStream = "user/-/state/com.google/reading-list";
const starredStream = "user/-/state/com.google/starred";
const readState = "user/-/state/com.google/read";
const keptUnreadState = "user/-/state/com.google/kept-unread";
const labelPrefix = "user/-/label/";

const textHeaders = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=UTF-8",
};
const jsonHeaders = { "cache-control": "no-store" };

const readerUsername = (env: Env): string => env.READER_USERNAME ?? env.USERNAME ?? "";
const readerToken = (env: Env): string => env.READER_TOKEN ?? env.PASSWORD ?? "";
const adminToken = (env: Env): string => env.ADMIN_TOKEN ?? env.PASSWORD ?? "";

const textResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: textHeaders });

const digest = async (value: string): Promise<Uint8Array> => {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(result);
};

const safeEqual = async (left: string, right: string): Promise<boolean> => {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
};

const requireReader: MiddlewareHandler<AppBindings> = async (context, next) => {
  const params = await readerParams(context.req.raw);
  context.set("readerParams", params);

  const token = readerToken(context.env);
  const credential = readerCredential(context.req.header("Authorization"));
  const headerValid = credential !== null && (await safeEqual(credential, token));
  const isWrite = context.req.method !== "GET" && context.req.method !== "HEAD";
  const editToken = isWrite ? params.get("T") : null;
  const editTokenValid = editToken !== null && (await safeEqual(editToken, token));

  if (!headerValid && !editTokenValid) {
    const error = credential === null && editToken === null ? "AuthRequired" : "InvalidAuthToken";
    return textResponse(`Error=${error}\n`, 401);
  }

  await next();
};

const requireAdmin: MiddlewareHandler<AppBindings> = async (context, next) => {
  const authorization = context.req.header("Authorization");
  const prefix = "Bearer ";
  if (authorization === undefined || !authorization.startsWith(prefix)) {
    return context.json({ error: "unauthorized" }, 401, jsonHeaders);
  }
  if (!(await safeEqual(authorization.slice(prefix.length), adminToken(context.env)))) {
    return context.json({ error: "unauthorized" }, 401, jsonHeaders);
  }
  await next();
};

const parsePositiveInt = (value: string | null, fallback: number, max: number): number | null => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
};

const parseFeedStream = (stream: string): number | null => {
  const match = /^feed\/(\d+)$/u.exec(stream);
  if (match === null) return null;
  const id = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const parseSeconds = (raw: string | null): number | null => {
  if (raw === null || raw === "") return null;
  if (!/^\d+$/u.test(raw)) return Number.NaN;
  const seconds = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    return Number.NaN;
  }
  return seconds * 1_000;
};

type StreamSelection =
  | {
      stream: string;
      filter: StreamFilter;
      cursor: ReturnType<typeof decodeContinuation>;
      limit: number;
    }
  | { error: "BadRequest" | "BadContinuation" | "UnsupportedFilter" | "UnsupportedStream" };

const parseStreamSelection = (
  params: URLSearchParams,
  explicitStream?: string,
  allowReadStream = true,
): StreamSelection => {
  const stream = normalizeReaderStream(explicitStream ?? params.get("s") ?? readingListStream);
  const feedId = parseFeedStream(stream);
  const folderName = parseLabelName(stream);
  const includeTargets = new Set(params.getAll("it").map(normalizeReaderStream));
  const excludeTargets = new Set(params.getAll("xt").map(normalizeReaderStream));
  const supportedIncludes = new Set([readingListStream, readState, starredStream]);
  const supportedExcludes = new Set([readState, starredStream]);

  if ([...includeTargets].some((target) => !supportedIncludes.has(target))) {
    return { error: "UnsupportedFilter" };
  }
  if ([...excludeTargets].some((target) => !supportedExcludes.has(target))) {
    return { error: "UnsupportedFilter" };
  }

  const supportedBase =
    stream === readingListStream ||
    stream === starredStream ||
    (allowReadStream && stream === readState) ||
    feedId !== null ||
    folderName !== null;
  if (!supportedBase) return { error: "UnsupportedStream" };

  const limit = parsePositiveInt(params.get("n"), 10_000, 10_000);
  if (limit === null) return { error: "BadRequest" };

  const afterTime = parseSeconds(params.get("ot"));
  const beforeTime = parseSeconds(params.get("nt"));
  if (Number.isNaN(afterTime) || Number.isNaN(beforeTime)) return { error: "BadRequest" };

  const rawContinuation = params.get("c");
  const cursor = decodeContinuation(rawContinuation);
  if (rawContinuation !== null && cursor === null) return { error: "BadContinuation" };

  return {
    stream,
    filter: {
      feedId,
      folderName,
      unreadOnly: excludeTargets.has(readState),
      readOnly: stream === readState || includeTargets.has(readState),
      starredOnly: stream === starredStream || includeTargets.has(starredStream),
      unstarredOnly: excludeTargets.has(starredStream),
      afterTime,
      beforeTime,
      sortOldestFirst: params.get("r") === "o",
    },
    cursor,
    limit,
  };
};

const streamTitle = (
  stream: string,
  entries: Awaited<ReturnType<typeof findReaderEntries>>,
): string => {
  if (stream === readingListStream) return "Reading List";
  if (stream === starredStream) return "Starred";
  const folderName = parseLabelName(stream);
  if (folderName !== null) return folderName;
  return entries[0]?.feedTitle ?? stream;
};

const parseLabelName = (value: string | null): string | null => {
  if (value === null) return null;
  const normalized = normalizeReaderStream(value);
  if (!normalized.startsWith(labelPrefix)) return null;
  const name = normalized.slice(labelPrefix.length).trim();
  return name === "" ? null : name;
};

const labelId = (name: string): string => `${labelPrefix}${name}`;

const parseReaderCutoffMs = (raw: string | null, fallback: number): number | null => {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) return null;
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < 1_000_000_000) return null;

  let milliseconds: number;
  if (numeric >= 100_000_000_000_000) {
    milliseconds = Math.floor(numeric / 1_000);
  } else if (numeric >= 100_000_000_000) {
    milliseconds = numeric;
  } else {
    milliseconds = numeric * 1_000;
  }

  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const parseMarkAllScope = (stream: string): MarkAllScope | null => {
  const normalized = normalizeReaderStream(stream);
  if (normalized === readingListStream) return { kind: "reading-list" };
  const feedId = parseFeedStream(normalized);
  if (feedId !== null) return { kind: "feed", feedId };
  const folderName = parseLabelName(normalized);
  return folderName === null ? null : { kind: "folder", folderName };
};

app.get("/health", (context) => context.json({ status: "ok", service: "rss-sync-worker" }));

app.use("/admin/*", requireAdmin);
app.get("/admin/status", (context) => context.json({ status: "ok" }, 200, jsonHeaders));

app.post("/api/reader/accounts/ClientLogin", async (context) => {
  const form = await readerParams(context.req.raw);
  const username = form.get("Email") ?? "";
  const password = form.get("Passwd") ?? "";
  const [usernameMatches, passwordMatches] = await Promise.all([
    safeEqual(username, readerUsername(context.env)),
    safeEqual(password, readerToken(context.env)),
  ]);

  if (!usernameMatches || !passwordMatches) return textResponse("Error=BadAuthentication\n", 403);
  const credential = readerToken(context.env);
  return textResponse(`SID=${credential}\nLSID=${credential}\nAuth=${credential}\n`);
});

app.use(`${readerRoot}/*`, requireReader);

app.get(`${readerRoot}/token`, (context) => textResponse(readerToken(context.env)));

app.get(`${readerRoot}/user-info`, (context) =>
  context.json(
    {
      userId: "1",
      userName: readerUsername(context.env),
      userEmail: readerUsername(context.env),
      userProfileId: "1",
    },
    200,
    jsonHeaders,
  ),
);

app.post(`${readerRoot}/subscription/quickadd`, async (context) => {
  try {
    const form = context.get("readerParams");
    const requestedUrl = form.get("quickadd") ?? "";
    if (requestedUrl.trim() === "") return context.json({ error: "BadRequest" }, 400, jsonHeaders);

    const now = Date.now();
    const feedId = await ensureSubscription(context.env.DB, requestedUrl, now);
    await enqueueFeedRefresh(context.env, feedId, now);
    return context.json(
      { numResults: 1, query: requestedUrl, streamId: `feed/${feedId}`, streamName: "" },
      200,
      jsonHeaders,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "subscription failed";
    const status = message.includes("feed URL") || message.includes("Invalid URL") ? 400 : 503;
    return context.json(
      { error: status === 400 ? "BadRequest" : "ServiceUnavailable" },
      status,
      jsonHeaders,
    );
  }
});

app.get(`${readerRoot}/subscription/list`, async (context) => {
  const [subscriptions, memberships] = await Promise.all([
    listSubscriptions(context.env.DB),
    listSubscriptionFolders(context.env.DB),
  ]);
  const categoriesByFeed = new Map<number, Array<{ id: string; label: string; type: string }>>();
  for (const membership of memberships) {
    const categories = categoriesByFeed.get(membership.feedId) ?? [];
    categories.push({ id: labelId(membership.name), label: membership.name, type: "folder" });
    categoriesByFeed.set(membership.feedId, categories);
  }

  return context.json(
    {
      subscriptions: subscriptions.map((subscription) => ({
        id: `feed/${subscription.feedId}`,
        url: subscription.feedUrl,
        htmlUrl: subscription.siteUrl ?? "",
        title: subscription.title,
        categories: categoriesByFeed.get(subscription.feedId) ?? [],
        iconUrl: "",
      })),
    },
    200,
    jsonHeaders,
  );
});

app.post(`${readerRoot}/subscription/edit`, async (context) => {
  const form = context.get("readerParams");
  const action = form.get("ac") ?? "edit";
  const now = Date.now();
  const streamValue = form.get("s") ?? "";
  let feedId = parseFeedStream(normalizeReaderStream(streamValue));
  if (feedId === null && action === "subscribe" && streamValue.startsWith("feed/")) {
    try {
      feedId = await ensureSubscription(context.env.DB, streamValue.slice("feed/".length), now);
      await enqueueFeedRefresh(context.env, feedId, now);
    } catch {
      return context.json({ error: "BadSubscription" }, 400, jsonHeaders);
    }
  }
  if (feedId === null) return context.json({ error: "BadSubscription" }, 400, jsonHeaders);
  const active = action === "subscribe" ? true : action === "unsubscribe" ? false : undefined;
  if (action !== "edit" && active === undefined) {
    return context.json({ error: "BadAction" }, 400, jsonHeaders);
  }

  const title = form.has("t") ? form.get("t") : undefined;
  const exists = await updateSubscription(context.env.DB, feedId, { active, title }, now);
  if (!exists) return context.json({ error: "UnknownSubscription" }, 404, jsonHeaders);

  for (const value of form.getAll("a")) {
    const name = parseLabelName(value);
    if (name !== null) await addFolderMembership(context.env.DB, feedId, name, now);
  }
  for (const value of form.getAll("r")) {
    const name = parseLabelName(value);
    if (name !== null) await removeFolderMembership(context.env.DB, feedId, name);
  }

  return textResponse("OK\n");
});

app.get(`${readerRoot}/tag/list`, async (context) => {
  const folders = await listFolders(context.env.DB);
  return context.json(
    {
      tags: [
        { id: starredStream },
        ...folders.map((folder) => ({
          id: labelId(folder.name),
          label: folder.name,
          type: "folder",
        })),
      ],
    },
    200,
    jsonHeaders,
  );
});

app.post(`${readerRoot}/rename-tag`, async (context) => {
  const form = context.get("readerParams");
  const source = parseLabelName(form.get("s"));
  const destination = parseLabelName(form.get("dest"));
  if (source === null || destination === null) {
    return context.json({ error: "BadTag" }, 400, jsonHeaders);
  }
  await renameFolder(context.env.DB, source, destination, Date.now());
  return textResponse("OK\n");
});

app.post(`${readerRoot}/disable-tag`, async (context) => {
  const form = context.get("readerParams");
  const name = parseLabelName(form.get("s"));
  if (name === null) return context.json({ error: "BadTag" }, 400, jsonHeaders);
  await deleteFolder(context.env.DB, name);
  return textResponse("OK\n");
});

app.get(`${readerRoot}/unread-count`, async (context) => {
  const unreadcounts = await listUnreadCounts(context.env.DB, readingListStream, labelId);
  return context.json({ max: unreadcounts[0]?.count ?? 0, unreadcounts }, 200, jsonHeaders);
});

app.get(`${readerRoot}/stream/items/ids`, async (context) => {
  const selection = parseStreamSelection(context.get("readerParams"));
  if ("error" in selection) return context.json({ error: selection.error }, 400, jsonHeaders);

  const page = await listStreamItemIds(
    context.env.DB,
    selection.filter,
    selection.cursor,
    selection.limit,
  );
  const last = page.items.at(-1);
  return context.json(
    {
      itemRefs: page.items.map((item) => ({ id: String(item.id) })),
      ...(page.hasMore && last !== undefined
        ? { continuation: encodeContinuation({ ingestedAt: last.ingestedAt, id: last.id }) }
        : {}),
    },
    200,
    jsonHeaders,
  );
});

const streamContentsPrefix = `${readerRoot}/stream/contents/`;
app.get(`${readerRoot}/stream/contents/*`, async (context) => {
  const pathname = new URL(context.req.url).pathname;
  const encodedStream = pathname.slice(streamContentsPrefix.length);
  let stream: string;
  try {
    stream = decodeURIComponent(encodedStream);
  } catch {
    return context.json({ error: "UnsupportedStream" }, 400, jsonHeaders);
  }

  const selection = parseStreamSelection(context.get("readerParams"), stream, false);
  if ("error" in selection) return context.json({ error: selection.error }, 400, jsonHeaders);

  const page = await listStreamItemIds(
    context.env.DB,
    selection.filter,
    selection.cursor,
    selection.limit,
  );
  const entries = await findReaderEntries(
    context.env.DB,
    page.items.map((item) => item.id),
  );
  const last = page.items.at(-1);

  return context.json(
    {
      direction: "ltr",
      id: selection.stream,
      title: streamTitle(selection.stream, entries),
      updated: Math.floor(Date.now() / 1_000),
      items: entries.map(googleEntry),
      ...(page.hasMore && last !== undefined
        ? { continuation: encodeContinuation({ ingestedAt: last.ingestedAt, id: last.id }) }
        : {}),
    },
    200,
    jsonHeaders,
  );
});

app.post(`${readerRoot}/stream/items/contents`, async (context) => {
  const form = context.get("readerParams");
  const rawIds = form.getAll("i");
  if (rawIds.length > 1_000) return context.json({ error: "TooManyItems" }, 400, jsonHeaders);

  const ids: number[] = [];
  for (const value of rawIds) {
    const id = parseItemId(value);
    if (id === null) return context.json({ error: "BadItemId" }, 400, jsonHeaders);
    ids.push(id);
  }

  const entries = await findReaderEntries(context.env.DB, ids);
  return context.json(
    {
      direction: "ltr",
      id: readingListStream,
      title: "Reading List",
      self: [
        {
          href: new URL(`${readerRoot}/stream/items/contents`, new URL(context.req.url).origin)
            .href,
        },
      ],
      author: readerUsername(context.env),
      items: entries.map(googleEntry),
      updated: Math.floor(Date.now() / 1_000),
    },
    200,
    jsonHeaders,
  );
});

app.post(`${readerRoot}/edit-tag`, async (context) => {
  const form = context.get("readerParams");
  const rawIds = form.getAll("i");
  if (rawIds.length > 1_000) return context.json({ error: "TooManyItems" }, 400, jsonHeaders);

  const ids: number[] = [];
  for (const rawId of rawIds) {
    const id = parseItemId(rawId);
    if (id === null) return context.json({ error: "BadItemId" }, 400, jsonHeaders);
    ids.push(id);
  }

  const add = new Set(form.getAll("a").map(normalizeReaderStream));
  const remove = new Set(form.getAll("r").map(normalizeReaderStream));
  const readTrue = add.has(readState) || remove.has(keptUnreadState);
  const readFalse = remove.has(readState) || add.has(keptUnreadState);
  const starredTrue = add.has(starredStream);
  const starredFalse = remove.has(starredStream);
  if ((readTrue && readFalse) || (starredTrue && starredFalse)) {
    return context.json({ error: "ContradictoryStateMutation" }, 400, jsonHeaders);
  }

  const mutation: { isRead?: boolean; isStarred?: boolean } = {};
  if (readTrue) mutation.isRead = true;
  if (readFalse) mutation.isRead = false;
  if (starredTrue) mutation.isStarred = true;
  if (starredFalse) mutation.isStarred = false;

  await mutateEntryStates(context.env.DB, ids, mutation, Date.now());
  return textResponse("OK\n");
});

app.post(`${readerRoot}/mark-all-as-read`, async (context) => {
  const form = context.get("readerParams");
  const scope = parseMarkAllScope(form.get("s") ?? readingListStream);
  if (scope === null) return context.json({ error: "UnsupportedStream" }, 400, jsonHeaders);

  const changedAt = Date.now();
  const cutoffMs = parseReaderCutoffMs(form.get("ts"), changedAt);
  if (cutoffMs === null) return context.json({ error: "BadTimestamp" }, 400, jsonHeaders);

  await markStreamRead(context.env.DB, scope, cutoffMs, changedAt);
  return textResponse("OK\n");
});

const worker = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    await dispatchDueFeeds(env);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processRefreshMessage(env, message.body);
        message.ack();
      } catch (error) {
        console.error("feed refresh failed", {
          feedId: message.body.feedId,
          error: error instanceof Error ? error.name : "unknown",
        });
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, RefreshMessage>;

export default worker;
