import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { discoverFeed } from "./feed/discovery";
import { FeedFetchError } from "./feed/fetch";
import { readFeedIcon } from "./feed/icon";
import {
  deleteFoldersAndReassign,
  findFolderByName,
  listFolders,
  listSubscriptionFolders,
  renameFolder,
  replaceFolderMembership,
  updateSubscription,
} from "./folder-store";
import { type MarkAllScope, markStreamRead } from "./mark-all-store";
import { decodeContinuation, encodeContinuation, googleEntry, parseItemId } from "./protocol";
import {
  normalizeReaderStream,
  readerBodyParams,
  readerCredential,
  readerParams,
} from "./reader-request";
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

  const expected = readerToken(context.env);
  const credential =
    context.req.method === "POST"
      ? params.get("T")
      : readerCredential(context.req.header("Authorization"));
  if (credential === null || !(await safeEqual(credential, expected))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...textHeaders, "X-Reader-Google-Bad-Token": "true" },
    });
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

const parseReaderLimit = (value: string | null): number => {
  if (value === null || value === "" || !/^\d+$/u.test(value)) return 10_000;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : 10_000;
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
  const streamValues = params.getAll("s");
  if (explicitStream === undefined && streamValues.length !== 1) return { error: "BadRequest" };
  const stream = normalizeReaderStream(explicitStream ?? streamValues[0] ?? "");
  const feedId = parseFeedStream(stream);
  const folderName = parseLabelName(stream);
  const excludeTargets = new Set(params.getAll("xt").map(normalizeReaderStream));
  const supportedExcludes = new Set([readState, starredStream]);

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
      readOnly: stream === readState,
      starredOnly: stream === starredStream,
      unstarredOnly: excludeTargets.has(starredStream),
      afterTime,
      beforeTime,
      sortOldestFirst: params.get("r") === "o",
    },
    cursor,
    limit: parseReaderLimit(params.get("n")),
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

app.get("/feed-icon/:externalId", async (context) => {
  const icon = await readFeedIcon(context.env.DB, context.req.param("externalId"));
  if (icon === null) return new Response("Not Found", { status: 404 });

  const headers = new Headers({
    "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    "content-type": icon.mediaType,
    etag: icon.etag,
    "x-content-type-options": "nosniff",
  });
  if (context.req.header("If-None-Match") === icon.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(icon.body, { status: 200, headers });
});

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

  if (!usernameMatches || !passwordMatches) {
    return context.json({ error_message: "access unauthorized" }, 401, jsonHeaders);
  }

  const credential = readerToken(context.env);
  const loginResult = { SID: credential, LSID: credential, Auth: credential };
  if (form.get("output") === "json") return context.json(loginResult, 200, jsonHeaders);
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
    if (requestedUrl.trim() === "") {
      return context.json({ error_message: "invalid URL" }, 400, jsonHeaders);
    }

    const discovered = await discoverFeed(requestedUrl);
    if (discovered === null) {
      return context.json({ numResults: 0, query: requestedUrl }, 200, jsonHeaders);
    }

    const now = Date.now();
    const feedId = await ensureSubscription(context.env.DB, discovered.feedUrl, now);
    const meta = await context.env.DB.prepare(
      `SELECT f.canonical_feed_url AS feedUrl,
              f.title AS feedTitle,
              s.custom_title AS customTitle
       FROM feeds f
       JOIN subscriptions s ON s.feed_id = f.id
       WHERE f.id = ?`,
    )
      .bind(feedId)
      .first<{ feedUrl: string; feedTitle: string | null; customTitle: string | null }>();
    await enqueueFeedRefresh(context.env, feedId, now);

    const canonicalUrl = meta?.feedUrl ?? discovered.feedUrl;
    const storedTitle = meta?.feedTitle?.trim();
    const streamName =
      meta?.customTitle?.trim() ||
      (storedTitle !== undefined && storedTitle !== canonicalUrl ? storedTitle : "") ||
      discovered.title ||
      canonicalUrl;
    return context.json(
      { numResults: 1, query: canonicalUrl, streamId: `feed/${feedId}`, streamName },
      200,
      jsonHeaders,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "subscription failed";
    const status =
      error instanceof FeedFetchError &&
      (error.code === "invalid_url" ||
        error.code === "unsafe_target" ||
        error.code === "response_too_large")
        ? 400
        : 503;
    return context.json({ error_message: message }, status, jsonHeaders);
  }
});

app.get(`${readerRoot}/subscription/list`, async (context) => {
  if (context.get("readerParams").get("output") !== "json") {
    return context.json({ error_message: "only json output is supported" }, 400, jsonHeaders);
  }

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
        iconUrl:
          subscription.iconExternalId === null
            ? ""
            : `${new URL(context.req.url).origin}/feed-icon/${encodeURIComponent(subscription.iconExternalId)}`,
      })),
    },
    200,
    jsonHeaders,
  );
});

app.post(`${readerRoot}/subscription/edit`, async (context) => {
  const form = context.get("readerParams");
  const action = form.get("ac") ?? "";
  const streams = form.getAll("s");
  if (streams.length === 0) {
    return context.json({ error_message: "no valid stream IDs provided" }, 400, jsonHeaders);
  }

  const now = Date.now();
  const title = form.get("t") ?? "";
  const label = form.has("a") ? parseLabelName(form.get("a")) : null;
  if (form.has("a") && label === null) {
    return context.json({ error_message: "destination must be a label" }, 400, jsonHeaders);
  }
  if (form.has("r")) {
    return context.json(
      { error_message: "removing subscription labels is not supported" },
      400,
      jsonHeaders,
    );
  }

  if (action === "subscribe") {
    const stream = streams[0] ?? "";
    if (!stream.startsWith("feed/")) {
      return context.json({ error_message: "invalid feed stream" }, 400, jsonHeaders);
    }
    try {
      const feedId = await ensureSubscription(context.env.DB, stream.slice("feed/".length), now);
      if (title !== "") await updateSubscription(context.env.DB, feedId, { title }, now);
      if (label !== null) await replaceFolderMembership(context.env.DB, feedId, label, now);
      await enqueueFeedRefresh(context.env, feedId, now);
      return textResponse("OK");
    } catch (error) {
      const message = error instanceof Error ? error.message : "subscription failed";
      return context.json({ error_message: message }, 400, jsonHeaders);
    }
  }

  if (action === "unsubscribe") {
    const feedIds = streams.map((stream) => parseFeedStream(normalizeReaderStream(stream)));
    if (feedIds.some((feedId) => feedId === null)) {
      return context.json({ error_message: "invalid feed stream" }, 400, jsonHeaders);
    }
    for (const feedId of feedIds) {
      const exists = await updateSubscription(
        context.env.DB,
        feedId as number,
        { active: false },
        now,
      );
      if (!exists) return context.json({ error_message: "feed not found" }, 404, jsonHeaders);
    }
    return textResponse("OK");
  }

  if (action === "edit") {
    const feedId = parseFeedStream(normalizeReaderStream(streams[0] ?? ""));
    if (feedId === null) {
      return context.json({ error_message: "invalid feed stream" }, 400, jsonHeaders);
    }
    const exists = await updateSubscription(
      context.env.DB,
      feedId,
      { title: form.has("t") ? title : undefined },
      now,
    );
    if (!exists) return context.json({ error_message: "feed not found" }, 404, jsonHeaders);
    if (label !== null) await replaceFolderMembership(context.env.DB, feedId, label, now);
    return textResponse("OK");
  }

  return context.json({ error_message: `unrecognized action ${action}` }, 400, jsonHeaders);
});

app.get(`${readerRoot}/tag/list`, async (context) => {
  if (context.get("readerParams").get("output") !== "json") {
    return context.json({ error_message: "only json output is supported" }, 400, jsonHeaders);
  }

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
    return context.json({ error_message: "invalid label" }, 400, jsonHeaders);
  }
  if ((await findFolderByName(context.env.DB, source)) === null) {
    return context.json({ error_message: "label not found" }, 404, jsonHeaders);
  }
  await renameFolder(context.env.DB, source, destination, Date.now());
  return textResponse("OK");
});

app.post(`${readerRoot}/disable-tag`, async (context) => {
  const form = context.get("readerParams");
  const names = form.getAll("s").map((value) => parseLabelName(value));
  if (names.length === 0 || names.some((name) => name === null)) {
    return context.json({ error_message: "only labels are supported" }, 400, jsonHeaders);
  }
  try {
    await deleteFoldersAndReassign(context.env.DB, names as string[]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "tag deletion failed";
    return context.json({ error_message: message }, 400, jsonHeaders);
  }
  return textResponse("OK");
});

app.get(`${readerRoot}/unread-count`, async (context) => {
  const unreadcounts = await listUnreadCounts(context.env.DB, readingListStream, labelId);
  return context.json({ max: unreadcounts[0]?.count ?? 0, unreadcounts }, 200, jsonHeaders);
});

app.get(`${readerRoot}/stream/items/ids`, async (context) => {
  if (context.get("readerParams").get("output") !== "json") {
    return context.json({ error_message: "only json output is supported" }, 400, jsonHeaders);
  }

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
  if (form.get("output") !== "json") {
    return context.json({ error_message: "only json output is supported" }, 400, jsonHeaders);
  }

  const rawIds = form.getAll("i");
  if (rawIds.length > 1_000) {
    return context.json({ error_message: "too many items" }, 400, jsonHeaders);
  }

  const ids: number[] = [];
  for (const value of rawIds) {
    const id = parseItemId(value);
    if (id === null) {
      return context.json({ error_message: "invalid item ID" }, 400, jsonHeaders);
    }
    ids.push(id);
  }

  const entries = await findReaderEntries(context.env.DB, ids);
  const direction = form.get("r") === "o" ? 1 : -1;
  entries.sort(
    (left, right) => direction * (left.ingestedAt - right.ingestedAt || left.id - right.id),
  );

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
  const body = await readerBodyParams(context.req.raw);
  const rawIds = form.getAll("i");
  if (rawIds.length > 1_000) {
    return context.json({ error_message: "too many items" }, 400, jsonHeaders);
  }

  const ids: number[] = [];
  for (const rawId of rawIds) {
    const id = parseItemId(rawId);
    if (id === null) {
      return context.json({ error_message: "invalid item ID" }, 400, jsonHeaders);
    }
    ids.push(id);
  }

  const add = new Set(body.getAll("a").map(normalizeReaderStream));
  const remove = new Set(body.getAll("r").map(normalizeReaderStream));
  const ignoredStates = new Set([
    "user/-/state/com.google/broadcast",
    "user/-/state/com.google/like",
    "user/-/state/com.google/tracking-kept-unread",
  ]);
  const supportedStates = new Set([readState, keptUnreadState, starredStream, ...ignoredStates]);
  const requestedStates = [...add, ...remove];
  if (
    ids.length === 0 ||
    requestedStates.length === 0 ||
    requestedStates.some((value) => !supportedStates.has(value))
  ) {
    return context.json({ error_message: "unsupported tag mutation" }, 400, jsonHeaders);
  }

  const readTrue = add.has(readState) || remove.has(keptUnreadState);
  const readFalse = remove.has(readState) || add.has(keptUnreadState);
  const starredTrue = add.has(starredStream);
  const starredFalse = remove.has(starredStream);
  if ((readTrue && readFalse) || (starredTrue && starredFalse)) {
    return context.json({ error_message: "contradictory state mutation" }, 400, jsonHeaders);
  }

  const mutation: { isRead?: boolean; isStarred?: boolean } = {};
  if (readTrue) mutation.isRead = true;
  if (readFalse) mutation.isRead = false;
  if (starredTrue) mutation.isStarred = true;
  if (starredFalse) mutation.isStarred = false;

  await mutateEntryStates(context.env.DB, ids, mutation, Date.now());
  return textResponse("OK");
});

app.post(`${readerRoot}/mark-all-as-read`, async (context) => {
  const form = context.get("readerParams");
  const cutoff = parseReaderCutoffMs(form.get("ts"), Date.now());
  if (cutoff === null) {
    return context.json({ error_message: "invalid timestamp" }, 400, jsonHeaders);
  }

  const scope = parseMarkAllScope(form.get("s") ?? "");
  if (scope === null) return textResponse("OK");
  if (
    scope.kind === "folder" &&
    (await findFolderByName(context.env.DB, scope.folderName)) === null
  ) {
    return context.json({ error_message: "label not found" }, 404, jsonHeaders);
  }

  await markStreamRead(context.env.DB, scope, cutoff, Date.now());
  return textResponse("OK");
});

app.all(`${readerRoot}/*`, (context) => context.json([], 200, jsonHeaders));

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
