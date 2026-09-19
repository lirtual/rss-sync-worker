export class FeedDecodeError extends Error {
  constructor(
    readonly code: "unsupported_charset" | "decode_error",
    message: string,
  ) {
    super(message);
    this.name = code;
  }
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;
const BOM_UTF16LE = [0xff, 0xfe] as const;
const BOM_UTF16BE = [0xfe, 0xff] as const;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);

const charsetFromContentType = (contentType: string | null): string | null => {
  if (contentType === null) return null;
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(contentType);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null;
};

const utf16Pattern = (bytes: Uint8Array): "utf-16le" | "utf-16be" | null => {
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x3c &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x3f &&
    bytes[3] === 0x00 &&
    bytes[4] === 0x78 &&
    bytes[5] === 0x00
  ) {
    return "utf-16le";
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x3c &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x3f &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x78
  ) {
    return "utf-16be";
  }
  return null;
};

const xmlDeclaredCharset = (bytes: Uint8Array): string | null => {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  let ascii = "";
  for (const byte of sample) ascii += String.fromCharCode(byte);
  const match = /^\s*<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)["']/iu.exec(ascii);
  return match?.[1]?.trim() || null;
};

const detectedCharset = (bytes: Uint8Array, contentType: string | null): string => {
  if (startsWith(bytes, BOM_UTF8)) return "utf-8";
  if (startsWith(bytes, BOM_UTF16LE)) return "utf-16le";
  if (startsWith(bytes, BOM_UTF16BE)) return "utf-16be";

  const httpCharset = charsetFromContentType(contentType);
  if (httpCharset !== null) return httpCharset;

  const utf16 = utf16Pattern(bytes);
  if (utf16 !== null) return utf16;

  return xmlDeclaredCharset(bytes) ?? "utf-8";
};

export interface DecodedFeedDocument {
  text: string;
  encoding: string;
}

export const decodeFeedDocument = (
  bytes: Uint8Array,
  contentType: string | null,
): DecodedFeedDocument => {
  const requested = detectedCharset(bytes, contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(requested, { fatal: true });
  } catch {
    throw new FeedDecodeError(
      "unsupported_charset",
      `unsupported feed charset: ${requested}`,
    );
  }

  try {
    return { text: decoder.decode(bytes), encoding: decoder.encoding };
  } catch {
    throw new FeedDecodeError(
      "decode_error",
      `feed body is not valid ${decoder.encoding} data`,
    );
  }
};
