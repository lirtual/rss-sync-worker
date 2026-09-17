const READER_ROOT = "/api/reader";

const classifyStream = (value: string): string => {
  if (value === "user/-/state/com.google/reading-list") return "reading-list";
  if (value === "user/-/state/com.google/starred") return "starred";
  if (value === "user/-/state/com.google/read") return "read";
  if (value === "user/-/state/com.google/kept-unread") return "kept-unread";
  if (/^feed\/\d+$/u.test(value)) return "feed/<id>";
  if (value.startsWith("user/-/label/")) return "label/<redacted>";
  return "<stream>";
};

const sanitizeValue = (key: string, value: string): string => {
  switch (key) {
    case "Email":
    case "Passwd":
    case "T":
      return "<redacted>";
    case "quickadd":
      return "<feed-url>";
    case "i":
      return "<item-id>";
    case "s":
    case "a":
    case "r":
      return classifyStream(value);
    case "dest":
      return "label/<redacted>";
    case "t":
      return "<title>";
    case "c":
      return "<continuation>";
    case "ts":
      return "<timestamp>";
    case "n":
      return /^\d+$/u.test(value) ? value : "<number>";
    case "ac":
      return ["edit", "subscribe", "unsubscribe"].includes(value) ? value : "<action>";
    default:
      return "<redacted>";
  }
};

const appendSanitized = (
  target: Record<string, string | string[]>,
  key: string,
  value: string,
): void => {
  const sanitized = sanitizeValue(key, value);
  const existing = target[key];
  if (existing === undefined) {
    target[key] = sanitized;
  } else if (Array.isArray(existing)) {
    existing.push(sanitized);
  } else {
    target[key] = [existing, sanitized];
  }
};

const sanitizeParams = (params: URLSearchParams): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of params) appendSanitized(result, key, value);
  return result;
};

export interface ReederTraceShape {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  form: Record<string, string | string[]> | null;
}

export const sanitizeReederRequest = async (request: Request): Promise<ReederTraceShape> => {
  const url = new URL(request.url);
  let form: Record<string, string | string[]> | null = null;
  const contentType = request.headers.get("content-type") ?? "";
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    form = sanitizeParams(new URLSearchParams(await request.clone().text()));
  }

  return {
    method: request.method,
    path: url.pathname.startsWith(READER_ROOT) ? url.pathname.slice(READER_ROOT.length) || "/" : url.pathname,
    query: sanitizeParams(url.searchParams),
    form,
  };
};

export const traceReederRequest = async (request: Request, enabled: string): Promise<void> => {
  if (enabled !== "1") return;
  console.info("reeder_request", await sanitizeReederRequest(request));
};
