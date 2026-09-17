import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

type AppBindings = {
  Bindings: Env;
};

const app = new Hono<AppBindings>();

const readerRoot = "/api/reader/reader/api/0";

const textHeaders = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=UTF-8",
};

const jsonHeaders = {
  "cache-control": "no-store",
};

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
  if (credential === null) {
    return textResponse("Error=AuthRequired\n", 401);
  }
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

  const token = authorization.slice(prefix.length);
  if (!(await safeEqual(token, context.env.ADMIN_TOKEN))) {
    return context.json({ error: "unauthorized" }, 401, jsonHeaders);
  }

  await next();
};

app.get("/health", (context) =>
  context.json({ status: "ok", service: "rss-sync-worker" }),
);

app.use("/admin/*", requireAdmin);
app.get("/admin/status", (context) =>
  context.json({ status: "ok" }, 200, jsonHeaders),
);

app.post("/api/reader/accounts/ClientLogin", async (context) => {
  const body = await context.req.text();
  const form = new URLSearchParams(body);
  const username = form.get("Email") ?? "";
  const password = form.get("Passwd") ?? "";

  const [usernameMatches, passwordMatches] = await Promise.all([
    safeEqual(username, context.env.READER_USERNAME),
    safeEqual(password, context.env.READER_TOKEN),
  ]);

  if (!usernameMatches || !passwordMatches) {
    return textResponse("Error=BadAuthentication\n", 403);
  }

  const credential = context.env.READER_TOKEN;
  return textResponse(`SID=${credential}\nLSID=${credential}\nAuth=${credential}\n`);
});

app.use(`${readerRoot}/*`, requireReader);

app.get(`${readerRoot}/token`, (context) =>
  textResponse(context.env.READER_TOKEN),
);

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

export default app;
