import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { dispatchDueFeeds, enqueueFeedRefresh, processRefreshMessage } from "./refresh";
import { ensureSubscription, listSubscriptions } from "./store";

type AppBindings = {
  Bindings: Env;
};

const app = new Hono<AppBindings>();
const readerRoot = "/api/reader/reader/api/0";

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

app.get("/health", (context) =>
  context.json({ status: "ok", service: "rss-sync-worker" }),
);

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
    return context.json({ error: status === 400 ? "BadRequest" : "ServiceUnavailable" }, status, jsonHeaders);
  }
});

app.get(`${readerRoot}/subscription/list`, async (context) => {
  const subscriptions = await listSubscriptions(context.env.DB);
  return context.json(
    {
      subscriptions: subscriptions.map((subscription) => ({
        id: `feed/${subscription.feedId}`,
        url: subscription.feedUrl,
        htmlUrl: subscription.siteUrl ?? "",
        title: subscription.title,
        categories: [],
        iconUrl: "",
      })),
    },
    200,
    jsonHeaders,
  );
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
