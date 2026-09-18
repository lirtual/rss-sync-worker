const REPEATED_READER_PARAMS = new Set(["i", "a", "r"]);

export const normalizeReaderStream = (value: string): string =>
  value.replace(/^user\/\d+\//u, "user/-/");

export const readerCredential = (authorization: string | undefined): string | null => {
  if (authorization === undefined) return null;
  const match = /^GoogleLogin auth=([^\s]+)$/u.exec(authorization);
  return match?.[1] ?? null;
};

export const readerParams = async (request: Request): Promise<URLSearchParams> => {
  const url = new URL(request.url);
  const merged = new URLSearchParams(url.search);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    !contentType.startsWith("application/x-www-form-urlencoded")
  ) {
    return merged;
  }

  const body = new URLSearchParams(await request.clone().text());
  const overridden = new Set<string>();
  for (const [key, value] of body) {
    if (!REPEATED_READER_PARAMS.has(key) && !overridden.has(key)) {
      merged.delete(key);
      overridden.add(key);
    }
    merged.append(key, value);
  }

  return merged;
};
