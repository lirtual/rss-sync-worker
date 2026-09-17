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
import { dispatchDueFeeds, enqueueFeedRefresh, processRefreshMessage } from "./refresh";
import { ensureSubscription, listSubscriptions } from "./store";

type AppBindings = {
  Bindings: Env;
};

const app = new Hono<AppBindings>();
const readerRoot = "/api/reader/reader/api/0";
const labelPrefix = "user/-/label/";

const textHeaders = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=UTF-8",
};
const jsonHeaders = { "cache-control": "no-store" };

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

const readerCredential = (authorization: string | undefined): string | null => {
  if (authorization === undefined) return null;
  const match = /^GoogleLogin auth=([^\s]+)$/u.exec(authorization);
  return match?.[1] ?? null;
};

const requireReader: MiddlewareHandler<AppBindings> = async (context, next) => {
  const credential = readerCredential(context.req.header("Authorization"));
  if (credential === null) return textResponse("Error=AuthRequired\n", 401);
  if (!(await safeEqual(credential, context.env.READER_TOKEN))) {
    return textResponse("Error=InvalidAuthToken\n", 403);
  }
  await next();
};

const requireAdmin: MiddlewareHandler<AppBindings> = async (context, next) => {
  const authorization = context.req.header("Authorization");
  const prefix = "Bearer ";
  if (authorization === undefined || !authorization.startsWith(prefix)) {
    return context.json({ error: "unauthorized" }, 401, jsonHeaders);
  }
  if (!(await safeEqual(authorization.slice(prefix.length), context.env.ADMIN_TOKEN))) {
    return context.json({ error: "unauthorized" }, 401, jsonHeaders);
  }
  await next();
};

const readerForm = async (request: Request): Promise<URLSearchParams> =>
  new URLSearchParams(await request.text());

const parseFeedId = (value: string | null): number | null => {
  if (value === null) return null;
  const match = /^feed\/(\d+)$/u.exec(value);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseLabelName = (value: string | null): string | null => {
  if (value === null || !value.startsWith(labelPrefix)) return null;
  const name = value.slice(labelPrefix.length).trim();
  return name === "" ? null : name;
};

const labelId = (name: string): string => `${labelPrefix}${name}`;

app.get("/health", (context) => context.json({ status: "ok", service: "rss-sync-worker" }));

app.use("/admin/*", requireAdmin);
app.get("/admin/status", (context) => context.json({ status: "ok" }, 200, jsonHeaders));

app.post("/api/reader/accounts/ClientLogin", async (context) => {
  const form = await readerForm(context.req.raw);
  const username = form.get("Email") ?? "";
  const password = form.get("Passwd") ?? "";
  const [usernameMatches, passwordMatches] = await Promise.all([
    safeEqual(username, context.env.READER_USERNAME),
    safeEqual(password, context.env.READER_TOKEN),
  ]);

  if (!usernameMatches || !passwordMatches) return textResponse("Error=BadAuthentication\n", 403);
  const credential = context.env.READER_TOKEN;
  return textResponse(`SID=${credential}\nLSID=${credential}\nAuth=${credential}\n`);
});

app.use(`${readerRoot}/*`, requireReader);

app.get(`${readerRoot}/token`, (context) => textResponse(context.env.READER_TOKEN));

app.get(`${readerRoot}/user-info`, (context) =>
  context.json(
    {
      userId: "1",
      userName: context.env.READER_USERNAME,
      userEmail: context.env.READER_USERNAME,
      userProfileId: "1",
    },
    200,
    jsonHeaders,
  ),
);

app.post(`${readerRoot}/subscription/quickadd`, async (context) => {
  try {
    const form = await readerForm(context.req.raw);
    const requestedUrl = form.get("quickadd") ?? "";
    if (requestedUrl.trim() === "") return context.json({ error: "BadRequest" }, 400, jsonHeaders);

    const now = Date.now();
    const feedId = await ensureSubscription(context.env.DB, requestedUrl, now);
    await enqueueFeedRefresh(context.env, feedId, now);
    return context.json({ streamId: `feed/${feedId}` }, 200, jsonHeaders);
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
  const form = await readerForm(context.req.raw);
  const feedId = parseFeedId(form.get("s"));
  if (feedId === null) return context.json({ error: "BadSubscription" }, 400, jsonHeaders);

  const action = form.get("ac") ?? "edit";
  const now = Date.now();
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

  return textResponse("OK");
});

app.get(`${readerRoot}/tag/list`, async (context) => {
  const folders = await listFolders(context.env.DB);
  return context.json(
    { tags: folders.map((folder) => ({ id: labelId(folder.name) })) },
    200,
    jsonHeaders,
  );
});

app.post(`${readerRoot}/rename-tag`, async (context) => {
  const form = await readerForm(context.req.raw);
  const source = parseLabelName(form.get("s"));
  const destination = parseLabelName(form.get("dest"));
  if (source === null || destination === null) {
    return context.json({ error: "BadTag" }, 400, jsonHeaders);
  }
  await renameFolder(context.env.DB, source, destination, Date.now());
  return textResponse("OK");
});

app.post(`${readerRoot}/disable-tag`, async (context) => {
  const form = await readerForm(context.req.raw);
  const name = parseLabelName(form.get("s"));
  if (name === null) return context.json({ error: "BadTag" }, 400, jsonHeaders);
  await deleteFolder(context.env.DB, name);
  return textResponse("OK");
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
