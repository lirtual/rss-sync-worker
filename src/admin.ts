import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { exportOpml, importOpml } from "./opml";

const MAX_OPML_BYTES = 1024 * 1024;
const noStoreHeaders = { "cache-control": "no-store" };

type AdminBindings = {
  Bindings: Env;
};

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

const requireAdmin: MiddlewareHandler<AdminBindings> = async (context, next) => {
  const authorization = context.req.header("Authorization");
  const prefix = "Bearer ";
  if (authorization === undefined || !authorization.startsWith(prefix)) {
    return context.json({ error: "unauthorized" }, 401, noStoreHeaders);
  }
  if (!(await safeEqual(authorization.slice(prefix.length), context.env.ADMIN_TOKEN))) {
    return context.json({ error: "unauthorized" }, 401, noStoreHeaders);
  }
  await next();
};

export const adminApp = new Hono<AdminBindings>();

adminApp.use("/admin/*", requireAdmin);

adminApp.get("/admin/status", (context) => context.json({ status: "ok" }, 200, noStoreHeaders));

adminApp.post("/admin/opml/import", async (context) => {
  const contentLength = context.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_OPML_BYTES) {
    return context.json({ error: "PayloadTooLarge" }, 413, noStoreHeaders);
  }

  const xml = await context.req.text();
  if (new TextEncoder().encode(xml).byteLength > MAX_OPML_BYTES) {
    return context.json({ error: "PayloadTooLarge" }, 413, noStoreHeaders);
  }

  try {
    const result = await importOpml(context.env, xml);
    return context.json(result, 200, noStoreHeaders);
  } catch (error) {
    console.warn("OPML import rejected", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return context.json({ error: "InvalidOpml" }, 400, noStoreHeaders);
  }
});

adminApp.get("/admin/opml/export", async (context) => {
  const xml = await exportOpml(context.env.DB);
  return new Response(xml, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/x-opml; charset=UTF-8",
      "content-disposition": 'attachment; filename="subscriptions.opml"',
    },
  });
});
