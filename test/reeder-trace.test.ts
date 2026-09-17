import { describe, expect, it } from "vitest";
import { sanitizeReederRequest } from "../src/reeder-trace";

describe("Reeder request trace sanitization", () => {
  it("redacts credentials, feed URLs, item IDs, titles, folders, and continuation tokens", async () => {
    const body = new URLSearchParams();
    body.append("Email", "real@example.com");
    body.append("Passwd", "super-secret");
    body.append("quickadd", "https://private.example/feed.xml");
    body.append("s", "feed/123");
    body.append("i", "456");
    body.append("a", "user/-/label/Personal Folder");
    body.append("r", "user/-/state/com.google/read");
    body.append("t", "Private title");
    body.append("c", "opaque-continuation");
    body.append("ts", "1800000000000000");
    body.append("ac", "edit");

    const trace = await sanitizeReederRequest(
      new Request(
        "https://rss-sync.example/api/reader/reader/api/0/subscription/edit?s=user%2F-%2Flabel%2FSecret&n=100&c=secret-cursor",
        {
          method: "POST",
          headers: {
            authorization: "GoogleLogin auth=real-reader-token",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
      ),
    );

    expect(trace).toEqual({
      method: "POST",
      path: "/reader/api/0/subscription/edit",
      query: {
        s: "label/<redacted>",
        n: "100",
        c: "<continuation>",
      },
      form: {
        Email: "<redacted>",
        Passwd: "<redacted>",
        quickadd: "<feed-url>",
        s: "feed/<id>",
        i: "<item-id>",
        a: "label/<redacted>",
        r: "read",
        t: "<title>",
        c: "<continuation>",
        ts: "<timestamp>",
        ac: "edit",
      },
    });

    const serialized = JSON.stringify(trace);
    for (const secret of [
      "real@example.com",
      "super-secret",
      "private.example",
      "Personal Folder",
      "Private title",
      "real-reader-token",
      "opaque-continuation",
      "secret-cursor",
      "456",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
