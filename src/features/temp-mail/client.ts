import {
  TempMailConfig,
  TempMailInbox,
  TempMailMailboxSession,
  TempMailMessage,
  TempMailMessageListResponse,
  TempMailMessagePage,
  TempMailMessageQuery,
  TempMailMessageSummary
} from "../../shared/types/tempMail";

const LOWERCASE_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

function pickRandom(charset: string) {
  const index = crypto.getRandomValues(new Uint32Array(1))[0] % charset.length;
  return charset[index];
}

function buildRandomMailboxName(prefix = "") {
  let name = prefix;

  for (let index = 0; index < 6; index += 1) {
    name += pickRandom(LOWERCASE_LETTERS);
  }

  for (let index = 0; index < 2; index += 1) {
    name += pickRandom(DIGITS);
  }

  return name;
}

function joinUrl(baseUrl: string, pathname: string) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

  return new URL(normalizedPath, normalizedBaseUrl).toString();
}

function decodeJwtPayload(token: string) {
  try {
    const [, payloadPart] = token.split(".");

    if (!payloadPart) {
      return {};
    }

    const normalized = payloadPart
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");

    return JSON.parse(atob(normalized));
  } catch {
    return {};
  }
}

function buildAdminHeaders(config: TempMailConfig) {
  const headers: Record<string, string> = {
    "x-admin-auth": config.adminAuth,
    "Content-Type": "application/json"
  };

  if (config.customAuth) {
    headers["x-custom-auth"] = config.customAuth;
  }

  return headers;
}

function buildAddressHeaders(session: TempMailMailboxSession) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.addressJwt}`,
    "Content-Type": "application/json"
  };

  if (session.customAuth) {
    headers["x-custom-auth"] = session.customAuth;
  }

  return headers;
}

function extractHeader(raw: string | undefined, headerName: string) {
  if (!raw) {
    return "";
  }

  const pattern = new RegExp(`^${headerName}:\\s*([^\\r\\n]*(?:\\r?\\n[\\t ]+[^\\r\\n]*)*)`, "im");
  const match = raw.match(pattern);

  return match?.[1]?.replace(/\r?\n[\t ]+/g, " ").trim() || "";
}

function normalizeCharset(charset: string) {
  const normalized = charset.trim().toLowerCase();

  if (normalized === "utf8") {
    return "utf-8";
  }

  if (normalized === "gbk" || normalized === "gb2312" || normalized === "gb18030") {
    return "gb18030";
  }

  return normalized;
}

function decodeBytes(bytes: Uint8Array, charset: string) {
  const normalizedCharset = normalizeCharset(charset);

  try {
    return new TextDecoder(normalizedCharset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeMimeEncodedWord(value: string) {
  const normalizedValue = value.replace(/\r?\n[\t ]+/g, " ").trim();

  return normalizedValue.replace(
    /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g,
    (_match, charset: string, encoding: string, encodedText: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          const binary = atob(encodedText);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          return decodeBytes(bytes, charset);
        }

        const normalizedText = encodedText.replace(/_/g, " ").replace(
          /=([0-9A-F]{2})/gi,
          (_hexMatch: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
        );
        const bytes = Uint8Array.from(normalizedText, (char) => char.charCodeAt(0));
        return decodeBytes(bytes, charset);
      } catch {
        return _match;
      }
    }
  );
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'"
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => namedEntities[name.toLowerCase()] || match);
}

function extractMailboxAddress(value: string) {
  const bracketMatch = value.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch?.[0]?.trim() || value.trim();
}

function looksLikeDuckAddress(value: string) {
  return /@duck\.com$/i.test(extractMailboxAddress(value));
}

function isLikelyRawMime(value: string) {
  return /[\r\n]/.test(value);
}

function resolveSourceAddress(message: TempMailMessage, raw: string | undefined, recipient: string) {
  const candidates = [
    extractHeader(raw, "X-Original-From"),
    extractHeader(raw, "X-Original-Sender"),
    extractHeader(raw, "Reply-To"),
    extractHeader(raw, "From"),
    extractHeader(raw, "Sender"),
    extractHeader(raw, "Return-Path"),
    message.source,
    message.from,
    extractHeader(raw, "Resent-From")
  ]
    .map((item) => decodeMimeEncodedWord(String(item || "")).trim())
    .filter(Boolean);

  const uniqueCandidates = Array.from(new Set(candidates));
  const recipientMailbox = extractMailboxAddress(recipient);

  const externalCandidate = uniqueCandidates.find((candidate) => {
    const mailbox = extractMailboxAddress(candidate);
    return mailbox && mailbox !== recipientMailbox && !looksLikeDuckAddress(candidate);
  });

  if (externalCandidate) {
    return externalCandidate;
  }

  const nonRecipientCandidate = uniqueCandidates.find((candidate) => {
    const mailbox = extractMailboxAddress(candidate);
    return mailbox && mailbox !== recipientMailbox;
  });

  return nonRecipientCandidate || "";
}

function splitMimeEntity(raw: string) {
  const match = raw.match(/\r?\n\r?\n/);

  if (!match || match.index === undefined) {
    return { headerBlock: raw, body: "" };
  }

  const separatorLength = match[0].length;

  return {
    headerBlock: raw.slice(0, match.index),
    body: raw.slice(match.index + separatorLength)
  };
}

function parseHeaderBlock(headerBlock: string) {
  const headers = new Map<string, string>();
  let currentName = "";

  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentName) {
      headers.set(currentName, `${headers.get(currentName) || ""} ${line.trim()}`.trim());
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    currentName = line.slice(0, separatorIndex).trim().toLowerCase();
    headers.set(currentName, line.slice(separatorIndex + 1).trim());
  }

  return headers;
}

function getHeaderValue(headers: Map<string, string>, headerName: string) {
  return headers.get(headerName.toLowerCase()) || "";
}

function extractBoundary(contentType: string) {
  const match = contentType.match(/boundary="?([^";]+)"?/i);
  return match?.[1]?.trim() || "";
}

function extractCharset(contentType: string) {
  const match = contentType.match(/charset="?([^";]+)"?/i);
  return match?.[1]?.trim() || "utf-8";
}

function decodeQuotedPrintable(value: string, charset: string) {
  const normalized = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current === "=" && /^[0-9A-F]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(current.charCodeAt(0));
  }

  return decodeBytes(new Uint8Array(bytes), charset);
}

function decodeTransferBody(body: string, encoding: string, charset: string) {
  const normalizedEncoding = encoding.trim().toLowerCase();

  if (normalizedEncoding === "base64") {
    try {
      const compact = body.replace(/\s+/g, "");
      const binary = atob(compact);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return decodeBytes(bytes, charset);
    } catch {
      return body;
    }
  }

  if (normalizedEncoding === "quoted-printable") {
    return decodeQuotedPrintable(body, charset);
  }

  return body;
}

type ParsedMimeBodies = {
  text: string;
  html: string;
  inlineResourceMap: Record<string, string>;
};

function normalizeInlineResourceId(value: string) {
  return value.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
}

function decodeQuotedPrintableBytes(value: string) {
  const normalized = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current === "=" && /^[0-9A-F]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(current.charCodeAt(0));
  }

  return new Uint8Array(bytes);
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function buildInlineResourceDataUrl(body: string, encoding: string, contentType: string) {
  const normalizedEncoding = encoding.trim().toLowerCase();

  try {
    if (normalizedEncoding === "base64") {
      const compact = body.replace(/\s+/g, "");
      atob(compact);
      return `data:${contentType};base64,${compact}`;
    }

    if (normalizedEncoding === "quoted-printable") {
      const bytes = decodeQuotedPrintableBytes(body);
      return `data:${contentType};base64,${encodeBase64(bytes)}`;
    }

    const bytes = new TextEncoder().encode(body);
    return `data:${contentType};base64,${encodeBase64(bytes)}`;
  } catch {
    return "";
  }
}

function parseMultipartBody(body: string, boundary: string) {
  const normalized = body.replace(/\r\n/g, "\n");
  const marker = `--${boundary}`;
  const rawParts = normalized.split(marker).slice(1);
  const parsedParts: ParsedMimeBodies[] = [];

  for (const rawPart of rawParts) {
    const part = rawPart.trim();

    if (!part || part === "--") {
      continue;
    }

    const cleanedPart = part.endsWith("--") ? part.slice(0, -2).trim() : part;
    if (!cleanedPart) {
      continue;
    }

    parsedParts.push(parseMimeBodies(cleanedPart));
  }

  return parsedParts.reduce<ParsedMimeBodies>(
    (result, part) => ({
      text: result.text || part.text,
      html: result.html || part.html,
      inlineResourceMap: {
        ...result.inlineResourceMap,
        ...part.inlineResourceMap
      }
    }),
    { text: "", html: "", inlineResourceMap: {} }
  );
}

function parseMimeBodies(raw: string): ParsedMimeBodies {
  const { headerBlock, body } = splitMimeEntity(raw);
  const headers = parseHeaderBlock(headerBlock);
  const contentType = getHeaderValue(headers, "content-type") || "text/plain";
  const transferEncoding = getHeaderValue(headers, "content-transfer-encoding");
  const charset = extractCharset(contentType);

  if (/multipart\//i.test(contentType)) {
    const boundary = extractBoundary(contentType);
    return boundary ? parseMultipartBody(body, boundary) : { text: "", html: "", inlineResourceMap: {} };
  }

  const decodedBody = decodeTransferBody(body, transferEncoding, charset).trim();
  const contentId = normalizeInlineResourceId(getHeaderValue(headers, "content-id"));
  const contentLocation = getHeaderValue(headers, "content-location").trim();

  if (/message\/rfc822/i.test(contentType)) {
    return parseMimeBodies(decodedBody);
  }

  if (/text\/html/i.test(contentType)) {
    return { text: cleanMailText(decodedBody), html: decodedBody, inlineResourceMap: {} };
  }

  if (/text\/plain/i.test(contentType) || !contentType) {
    return { text: decodedBody, html: "", inlineResourceMap: {} };
  }

  if (contentId && /^(image|audio|video)\//i.test(contentType)) {
    const dataUrl = buildInlineResourceDataUrl(body, transferEncoding, contentType);
    return {
      text: "",
      html: "",
      inlineResourceMap: dataUrl
        ? {
            [contentId]: dataUrl,
            ...(contentLocation ? { [normalizeInlineResourceId(contentLocation)]: dataUrl } : {})
          }
        : {}
    };
  }

  return { text: "", html: "", inlineResourceMap: {} };
}

function resolveMimeBodies(message: TempMailMessage): ParsedMimeBodies {
  const directText = typeof message.text === "string" ? message.text.trim() : "";
  const directHtml = typeof message.html === "string" ? message.html.trim() : "";
  const rawSource =
    (typeof message.raw === "string" && message.raw.trim()) ||
    (typeof message.source === "string" && message.source.trim()) ||
    "";
  const parsedRaw = rawSource ? parseMimeBodies(rawSource) : { text: "", html: "", inlineResourceMap: {} };

  if (directText || directHtml || Object.keys(parsedRaw.inlineResourceMap).length > 0) {
    return {
      text: directText || parsedRaw.text,
      html: directHtml || parsedRaw.html,
      inlineResourceMap: parsedRaw.inlineResourceMap
    };
  }

  if (!rawSource) {
    return { text: "", html: "", inlineResourceMap: {} };
  }

  return parsedRaw;
}

function cleanMailText(value: string) {
  return decodeHtmlEntities(
    value
    .replace(/=\r?\n/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim()
  )
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toMessageId(message: TempMailMessage, fallbackIndex: number) {
  const value = message.id;

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return `mail-${fallbackIndex}`;
}

function isMailLikeRecord(value: unknown): value is TempMailMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return [
    "id",
    "raw",
    "source",
    "subject",
    "from",
    "createdAt",
    "receivedAt",
    "mail_id"
  ].some((key) => key in record);
}

function normalizeMailRecord(message: TempMailMessage): TempMailMessage {
  const record = message as Record<string, unknown>;
  const rawSource =
    typeof message.source === "string"
      ? message.source
      : (record.source as string | undefined);
  const rawCandidate =
    typeof message.raw === "string"
      ? message.raw
      : (record.raw as string | undefined) ||
        (record.mime as string | undefined) ||
        (record.content as string | undefined) ||
        (rawSource && isLikelyRawMime(rawSource)
          ? rawSource
          : undefined);
  const sourceCandidate =
    rawSource && !isLikelyRawMime(rawSource)
      ? rawSource
      : (record.sender as string | undefined) ||
        (record.from_address as string | undefined);

  return {
    ...message,
    id:
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : (record.mail_id as string | number | undefined) ||
          (record.mailId as string | number | undefined),
    address:
      typeof message.address === "string"
        ? message.address
        : (record.address as string | undefined) ||
          (record.mailbox as string | undefined) ||
          (record.to_address as string | undefined),
    raw: rawCandidate,
    source: sourceCandidate,
    text:
      typeof message.text === "string"
        ? message.text
        : (record.body as string | undefined) || (record.plain as string | undefined),
    html:
      typeof message.html === "string"
        ? message.html
        : (record.html_content as string | undefined),
    from:
      typeof message.from === "string"
        ? message.from
        : (record.sender as string | undefined) ||
          (record.from_address as string | undefined),
    subject:
      typeof message.subject === "string"
        ? message.subject
        : (record.title as string | undefined),
    createdAt:
      typeof message.createdAt === "string"
        ? message.createdAt
        : (record.created_at as string | undefined) ||
          (record.createdAt as string | undefined),
    receivedAt:
      typeof message.receivedAt === "string"
        ? message.receivedAt
        : (record.received_at as string | undefined) ||
          (record.date as string | undefined)
  };
}

function findMailArray(value: unknown): TempMailMessage[] {
  if (Array.isArray(value)) {
    if (value.every((item) => isMailLikeRecord(item))) {
      return value.map((item) => normalizeMailRecord(item));
    }

    for (const item of value) {
      const nested = findMailArray(item);
      if (nested.length) {
        return nested;
      }
    }

    return [];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidateKeys = [
    "data",
    "mails",
    "items",
    "list",
    "rows",
    "records",
    "result",
    "results"
  ];

  for (const key of candidateKeys) {
    if (key in record) {
      const nested = findMailArray(record[key]);
      if (nested.length) {
        return nested;
      }
    }
  }

  return [];
}

function extractTotalCount(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const parseCandidate = (candidate: unknown) => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }

    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    return null;
  };
  const directCount =
    parseCandidate(record.count) ??
    parseCandidate(record.total) ??
    parseCandidate(record.totalCount);

  if (directCount !== null && Number.isFinite(directCount) && directCount >= 0) {
    return directCount;
  }

  const candidateKeys = ["data", "result", "results"];

  for (const key of candidateKeys) {
    const nested = extractTotalCount(record[key]);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

export function summarizeTempMailMessage(
  message: TempMailMessage,
  address: string,
  fallbackIndex = 0
): TempMailMessageSummary {
  const raw = typeof message.raw === "string" ? message.raw : undefined;
  const mimeBodies = resolveMimeBodies(message);
  const rawFromHeader = extractHeader(raw, "From");
  const subject = decodeMimeEncodedWord(
    String(message.subject || extractHeader(raw, "Subject") || "未解析主题")
  );
  const from = decodeMimeEncodedWord(
    String(rawFromHeader || message.from || "未知发件人")
  );
  const receivedAt = String(
    message.receivedAt ||
      message.createdAt ||
      extractHeader(raw, "Date") ||
      new Date().toISOString()
  );
  const content = decodeMimeEncodedWord(
    mimeBodies.text ? cleanMailText(mimeBodies.text) : cleanMailText(mimeBodies.html)
  );
  const htmlContent = mimeBodies.html;
  const recipientAddress = String(message.address || address || "");
  const sourceAddress = resolveSourceAddress(message, raw, recipientAddress);
  const preview = decodeMimeEncodedWord(
    String((content || subject || "").replace(/\s+/g, " ").trim().slice(0, 140))
  );

  return {
    id: toMessageId(message, fallbackIndex),
    address: recipientAddress,
    from,
    sourceAddress,
    recipientAddress,
    subject,
    receivedAt,
    preview,
    content,
    htmlContent,
    inlineResourceMap: mimeBodies.inlineResourceMap,
    raw
  };
}

export async function createTempMailInbox(
  config: TempMailConfig,
  customName?: string
): Promise<TempMailInbox> {
  const name = customName || buildRandomMailboxName(config.namePrefix);
  const response = await fetch(joinUrl(config.baseUrl, "/admin/new_address"), {
    method: "POST",
    headers: buildAdminHeaders(config),
    body: JSON.stringify({
      enablePrefix: config.enablePrefix,
      name,
      domain: config.domain
    })
  });

  if (!response.ok) {
    throw new Error(`Temp Mail inbox creation failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    address?: string;
    jwt?: string;
  };

  if (!data.jwt) {
    throw new Error("Temp Mail inbox creation failed: missing address JWT.");
  }

  const jwtPayload = decodeJwtPayload(data.jwt) as {
    address?: string;
  };

  return {
    address: data.address || jwtPayload.address || `${name}@${config.domain}`,
    addressJwt: data.jwt,
    createdAt: new Date().toISOString()
  };
}

export async function fetchTempMailMessagePage(
  session: TempMailMailboxSession,
  query: TempMailMessageQuery = {}
): Promise<TempMailMessagePage> {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 20),
    offset: String(query.offset ?? 0)
  });

  const response = await fetch(
    `${joinUrl(session.baseUrl, "/api/mails")}?${params.toString()}`,
    {
      method: "GET",
      headers: buildAddressHeaders(session)
    }
  );

  if (!response.ok) {
    throw new Error(`Temp Mail message fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as
    | TempMailMessage[]
    | TempMailMessageListResponse
    | Record<string, unknown>;

  return {
    messages: findMailArray(data),
    totalCount: extractTotalCount(data)
  };
}

export async function fetchTempMailMessages(
  session: TempMailMailboxSession,
  query: TempMailMessageQuery = {}
): Promise<TempMailMessage[]> {
  const result = await fetchTempMailMessagePage(session, query);
  return result.messages;
}

export async function fetchTempMailMessageSummaryPage(
  session: TempMailMailboxSession,
  query: TempMailMessageQuery = {}
): Promise<{ messages: TempMailMessageSummary[]; totalCount: number | null }> {
  const result = await fetchTempMailMessagePage(session, query);

  return {
    messages: result.messages.map((message, index) =>
      summarizeTempMailMessage(message, session.address, index)
    ),
    totalCount: result.totalCount
  };
}

export async function fetchTempMailMessageSummaries(
  session: TempMailMailboxSession,
  query: TempMailMessageQuery = {}
): Promise<TempMailMessageSummary[]> {
  const messages = await fetchTempMailMessages(session, query);

  return messages.map((message, index) =>
    summarizeTempMailMessage(message, session.address, index)
  );
}
