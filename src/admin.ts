import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { exportOpml, importOpml } from "./opml";
import {
  configuredDispatchBudget,
  getOperationalStatus,
  isActiveFeed,
  listFeedDiagnostics,
} from "./ops-store";
import { enqueueFeedRefresh } from "./refresh";

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
  // Missing/blank Admin credentials must never authenticate, even with Bearer "".
  if (
    !context.env.ADMIN_TOKEN ||
    !authorization.slice(prefix.length) ||
    !(await safeEqual(authorization.slice(prefix.length), context.env.ADMIN_TOKEN))
  ) {
    return context.json({ error: "unauthorized" }, 401, noStoreHeaders);
  }
  await next();
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number | null => {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const adminApp = new Hono<AdminBindings>();

adminApp.use("/admin/*", requireAdmin);

adminApp.get("/admin/status", async (context) => {
  const now = Date.now();
  const status = await getOperationalStatus(
    context.env.DB,
    now,
    configuredDispatchBudget(context.env),
  );
  return context.json({ status: "ok", ...status }, 200, noStoreHeaders);
});

adminApp.get("/admin/feeds", async (context) => {
  const after = parseNonNegativeInt(context.req.query("after"), 0);
  const limit = parseNonNegativeInt(context.req.query("limit"), 50);
  if (after === null || limit === null || limit < 1 || limit > 100) {
    return context.json({ error: "BadPagination" }, 400, noStoreHeaders);
  }

  const result = await listFeedDiagnostics(context.env.DB, after, limit);
  return context.json(result, 200, noStoreHeaders);
});

adminApp.post("/admin/feeds/:id/refresh", async (context) => {
  const rawId = context.req.param("id");
  if (!/^\d+$/u.test(rawId)) {
    return context.json({ error: "BadFeedId" }, 400, noStoreHeaders);
  }
  const feedId = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(feedId) || feedId < 1) {
    return context.json({ error: "BadFeedId" }, 400, noStoreHeaders);
  }
  if (!(await isActiveFeed(context.env.DB, feedId))) {
    return context.json({ error: "UnknownActiveFeed" }, 404, noStoreHeaders);
  }

  const outcome = await enqueueFeedRefresh(context.env, feedId);
  if (outcome === "budget-exhausted") {
    return context.json({ status: outcome }, 429, noStoreHeaders);
  }
  if (outcome === "delivery-uncertain") {
    return context.json({ status: outcome }, 503, noStoreHeaders);
  }
  return context.json({ status: outcome }, 202, noStoreHeaders);
});

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
    console.warn("opml_import_rejected", {
      errorClass: error instanceof Error ? error.name : "unknown",
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
