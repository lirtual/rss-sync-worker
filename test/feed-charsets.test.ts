import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decodeFeedDocument } from "../src/feed/decode";
import { processRefreshMessage } from "../src/refresh";
import { claimDispatch, ensureSubscription } from "../src/store";

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const xmlWithLegacyTitle = (
  encoding: string,
  titleBytes: Uint8Array,
): Uint8Array =>
  concat(
    ascii(`<?xml version="1.0" encoding="${encoding}"?><rss version="2.0"><channel><title>`),
    titleBytes,
    ascii(
      "</title><link>https://charset.example/</link><item><guid>one</guid><title>One</title></item></channel></rss>",
    ),
  );

const utf16 = (value: string, littleEndian: boolean): Uint8Array => {
  const output = new Uint8Array(2 + value.length * 2);
  output[0] = littleEndian ? 0xff : 0xfe;
  output[1] = littleEndian ? 0xfe : 0xff;
  let offset = 2;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (littleEndian) {
      output[offset] = unit & 0xff;
      output[offset + 1] = unit >> 8;
    } else {
      output[offset] = unit >> 8;
      output[offset + 1] = unit & 0xff;
    }
    offset += 2;
  }
  return output;
};

const refreshTitle = async (
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ result: string; title: string | null; errorClass: string | null }> => {
  const now = 1_830_000_000_000 + key.length * 10_000;
  const feedId = await ensureSubscription(env.DB, `https://${key}.example/feed.xml`, now);
  const message = await claimDispatch(env.DB, feedId, now);
  if (message === null) throw new Error("expected dispatch");

  const result = await processRefreshMessage(
    env,
    message,
    now + 1,
    async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
  );
  const row = await env.DB.prepare(
    "SELECT title, last_error_class AS errorClass FROM feeds WHERE id = ?",
  )
    .bind(feedId)
    .first<{ title: string | null; errorClass: string | null }>();
  return { result, title: row?.title ?? null, errorClass: row?.errorClass ?? null };
};

describe("feed charset decoding", () => {
  it("prefers BOM over a conflicting HTTP charset", () => {
    const document = utf16("<?xml version=\"1.0\"?><rss></rss>", true);
    const decoded = decodeFeedDocument(document, "application/xml; charset=windows-1252");
    expect(decoded.encoding).toBe("utf-16le");
    expect(decoded.text).toContain("<rss>");
  });

  it("decodes UTF-16LE and UTF-16BE through the refresh path", async () => {
    const xml =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>中文</title><link>https://charset.example/</link></channel></rss>';
    const little = await refreshTitle("utf16le", utf16(xml, true), "application/xml");
    const big = await refreshTitle("utf16be", utf16(xml, false), "application/xml");
    expect(little).toMatchObject({ result: "processed", title: "中文", errorClass: null });
    expect(big).toMatchObject({ result: "processed", title: "中文", errorClass: null });
  });

  it("decodes Windows-1252 declared by HTTP", async () => {
    const body = xmlWithLegacyTitle("windows-1252", new Uint8Array([0x43, 0x61, 0x66, 0xe9]));
    const result = await refreshTitle(
      "windows1252",
      body,
      "application/xml; charset=windows-1252",
    );
    expect(result).toMatchObject({ result: "processed", title: "Café", errorClass: null });
  });

  it("decodes GBK declared by the XML declaration", async () => {
    const body = xmlWithLegacyTitle("GBK", new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]));
    const result = await refreshTitle("gbk", body, "application/xml");
    expect(result).toMatchObject({ result: "processed", title: "中文", errorClass: null });
  });

  it("decodes Big5 declared by the XML declaration", async () => {
    const body = xmlWithLegacyTitle("Big5", new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]));
    const result = await refreshTitle("big5", body, "application/xml");
    expect(result).toMatchObject({ result: "processed", title: "中文", errorClass: null });
  });

  it("keeps UTF-8 as the undeclared default", async () => {
    const body = ascii(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>默认 UTF-8</title><link>https://charset.example/</link></channel></rss>',
    );
    const result = await refreshTitle("utf8-default", body, "application/xml");
    expect(result).toMatchObject({
      result: "processed",
      title: "默认 UTF-8",
      errorClass: null,
    });
  });

  it("classifies unsupported declared charsets without persisting mojibake", async () => {
    const body = ascii(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>Should not persist</title></channel></rss>',
    );
    const result = await refreshTitle(
      "unsupported-charset",
      body,
      "application/xml; charset=x-rss-sync-never",
    );
    expect(result).toMatchObject({
      result: "failed",
      title: null,
      errorClass: "unsupported_charset",
    });
  });
});
