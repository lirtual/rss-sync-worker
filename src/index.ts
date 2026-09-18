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
import { findReaderEntries, listStreamItemIds } from "./stream-store";

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
  if (!Number.isSafeInteger(numeric) || numeric < 0) return null;
  const milliseconds = numeric >= 100_000_000_000_000 ? Math.floor(numeric / 1_000) : numeric;
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
  const [globalResult, feedResult, folderResult] = await Promise.all([
    context.env.DB.prepare(
      "SELECT SUM(CASE WHEN es.is_read = 0 THEN 1 ELSE 0 END) AS count, COALESCE(MAX(e.ingested_at), 0) AS newest FROM entries e JOIN subscriptions s ON s.feed_id = e.feed_id AND s.active = 1 JOIN entry_states es ON es.entry_id = e.id",
    ).first<{ count: number | null; newest: number | null }>(),
    context.env.DB.prepare(
      "SELECT f.id AS feedId, SUM(CASE WHEN es.is_read = 0 THEN 1 ELSE 0 END) AS count, COALESCE(MAX(e.ingested_at), 0) AS newest FROM feeds f JOIN subscriptions s ON s.feed_id = f.id AND s.active = 1 LEFT JOIN entries e ON e.feed_id = f.id LEFT JOIN entry_states es ON es.entry_id = e.id GROUP BY f.id ORDER BY f.id",
    ).all<{ feedId: number; count: number | null; newest: number | null }>(),
    context.env.DB.prepare(
      "SELECT folder.name AS folderName, SUM(CASE WHEN es.is_read = 0 THEN 1 ELSE 0 END) AS count, COALESCE(MAX(e.ingested_at), 0) AS newest FROM folders folder JOIN subscription_folders sf ON sf.folder_id = folder.id JOIN subscriptions s ON s.feed_id = sf.feed_id AND s.active = 1 LEFT JOIN entries e ON e.feed_id = s.feed_id LEFT JOIN entry_states es ON es.entry_id = e.id GROUP BY folder.id, folder.name ORDER BY folder.name",
    ).all<{ folderName: string; count: number | null; newest: number | null }>(),
  ]);

  const unreadcounts: Array<{ id: string; count: number; newestItemTimestampUsec: string }> = [];
  const appendCount = (
    id: string,
    row: { count?: number | null; newest?: number | null } | null,
  ): void => {
    const count = Number(row?.count ?? 0);
    const newest = Number(row?.newest ?? 0);
    unreadcounts.push({
      id,
      count,
      newestItemTimestampUsec: String(Math.max(0, newest) * 1_000),
    });
  };

  appendCount(readingListStream, globalResult);
  for (const row of feedResult.results) appendCount(`feed/${row.feedId}`, row);
  for (const row of folderResult.results) appendCount(labelId(row.folderName), row);

  return context.json({ max: Number(globalResult?.count ?? 0), unreadcounts }, 200, jsonHeaders);
});

app.get(`${readerRoot}/stream/items/ids`, async (context) => {
  const params = context.get("readerParams");
  const stream = normalizeReaderStream(params.get("s") ?? readingListStream);
  const feedId = parseFeedStream(stream);
  const folderName = parseLabelName(stream);
  const includeTargets = new Set(params.getAll("it").map(normalizeReaderStream));
  const excludeTargets = new Set(params.getAll("xt").map(normalizeReaderStream));
  const readOnly = stream === readState || includeTargets.has(readState);
  const starredOnly = stream === starredStream || includeTargets.has(starredStream);

  if (
    stream !== readingListStream &&
    stream !== readState &&
    stream !== starredStream &&
    feedId === null &&
    folderName === null
  ) {
    return context.json({ error: "UnsupportedStream" }, 400, jsonHeaders);
  }

  const limit = parsePositiveInt(params.get("n"), 10_000, 10_000);
  if (limit === null) return context.json({ error: "BadRequest" }, 400, jsonHeaders);

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

  const afterTime = parseSeconds(params.get("ot"));
  const beforeTime = parseSeconds(params.get("nt"));
  if (Number.isNaN(afterTime) || Number.isNaN(beforeTime)) {
    return context.json({ error: "BadRequest" }, 400, jsonHeaders);
  }

  const rawContinuation = params.get("c");
  const cursor = decodeContinuation(rawContinuation);
  if (rawContinuation !== null && cursor === null) {
    return context.json({ error: "BadContinuation" }, 400, jsonHeaders);
  }

  const page = await listStreamItemIds(
    context.env.DB,
    {
      feedId,
      folderName,
      unreadOnly: excludeTargets.has(readState),
      readOnly,
      starredOnly,
      unstarredOnly: excludeTargets.has(starredStream),
      afterTime,
      beforeTime,
      sortOldestFirst: params.get("r") === "o",
    },
    cursor,
    limit,
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
  const mutation: { isRead?: boolean; isStarred?: boolean } = {};

  if (add.has(readState)) mutation.isRead = true;
  if (remove.has(readState) || add.has(keptUnreadState)) mutation.isRead = false;
  if (add.has(starredStream)) mutation.isStarred = true;
  if (remove.has(starredStream)) mutation.isStarred = false;

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
