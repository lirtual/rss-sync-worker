import { adminApp } from "./admin";
import readerWorker from "./index";

const isAdminPath = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return pathname === "/admin" || pathname.startsWith("/admin/");
};

const worker = {
  fetch(request, env, ctx) {
    if (isAdminPath(request)) return adminApp.fetch(request, env, ctx);
    return readerWorker.fetch(request, env, ctx);
  },
  scheduled(controller, env) {
    return readerWorker.scheduled(controller, env);
  },
  queue(batch, env) {
    return readerWorker.queue(batch, env);
  },
} satisfies ExportedHandler<Env, RefreshMessage>;

export default worker;
