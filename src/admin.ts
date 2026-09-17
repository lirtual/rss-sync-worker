import { Hono } from "hono";
import { exportOpml, importOpml } from "./opml";

const MAX_OPML_BYTES = 1024 * 1024;

type AdminBindings = {
  Bindings: Env;
};

export const adminApp = new Hono<AdminBindings>();

adminApp.get("/status", (context) => context.json({ status: "ok" }));

adminApp.post("/opml/import", async (context) => {
  const contentLength = context.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_OPML_BYTES) {
    return context.json({ error: "PayloadTooLarge" }, 413);
  }

  const xml = await context.req.text();
  if (new TextEncoder().encode(xml).byteLength > MAX_OPML_BYTES) {
    return context.json({ error: "PayloadTooLarge" }, 413);
  }

  try {
    const result = await importOpml(context.env, xml);
    return context.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    console.warn("OPML import rejected", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return context.json({ error: "InvalidOpml" }, 400, { "cache-control": "no-store" });
  }
});

adminApp.get("/opml/export", async (context) => {
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
