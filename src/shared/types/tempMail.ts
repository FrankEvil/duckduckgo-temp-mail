import { MailSummary } from "./mail";

export const TEMP_MAIL_ANY_DOMAIN = "__any__";

export type TempMailConfig = {
  baseUrl: string;
  adminAuth: string;
  customAuth: string;
  domain: string;
  domains: string[];
  autoRefreshEnabled: boolean;
  enablePrefix: boolean;
  namePrefix: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
};

export type TempMailInbox = {
  address: string;
  addressJwt: string;
  createdAt: string;
};

export type TempMailMessage = {
  id?: string | number;
  address?: string;
  raw?: string;
  source?: string;
  text?: string;
  html?: string;
  from?: string;
  subject?: string;
  to?: string;
  createdAt?: string;
  receivedAt?: string;
  [key: string]: unknown;
};

export type TempMailMessageListResponse = {
  mails?: TempMailMessage[];
  data?: TempMailMessage[];
  results?: TempMailMessage[];
  count?: number;
  total?: number;
};

export type TempMailMessageQuery = {
  limit?: number;
  offset?: number;
  address?: string;
};

export type TempMailMessagePage = {
  messages: TempMailMessage[];
  totalCount: number | null;
};

export type TempMailMailboxSession = TempMailConfig & TempMailInbox;

export type TempMailMessageSummary = MailSummary;

export function parseTempMailDomains(value: string | string[] | undefined | null) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,，]/g);

  return rawValues
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

export function normalizeTempMailDomainSelection(
  value: string | undefined | null,
  domains: string[],
  fallback?: string
) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (normalizedValue === TEMP_MAIL_ANY_DOMAIN && domains.length) {
    return TEMP_MAIL_ANY_DOMAIN;
  }

  if (normalizedValue && domains.includes(normalizedValue)) {
    return normalizedValue;
  }

  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  if (normalizedFallback && domains.includes(normalizedFallback)) {
    return normalizedFallback;
  }

  return domains[0] || normalizedFallback || "";
}

export function getTempMailConfiguredDomains(config: Pick<TempMailConfig, "domain" | "domains">) {
  const normalizedDomains = parseTempMailDomains(config.domains);
  const fallbackDomain = String(config.domain || "").trim().toLowerCase();

  if (!normalizedDomains.length && fallbackDomain && fallbackDomain !== TEMP_MAIL_ANY_DOMAIN) {
    return [fallbackDomain];
  }

  return normalizedDomains;
}

function pickRandomDomain(domains: string[]) {
  if (!domains.length) {
    return "";
  }

  return domains[Math.floor(Math.random() * domains.length)] || domains[0];
}

export function resolveTempMailCreateDomain(config: Pick<TempMailConfig, "domain" | "domains">) {
  const domains = getTempMailConfiguredDomains(config);
  if (!domains.length) {
    return "";
  }

  if (String(config.domain || "").trim().toLowerCase() === TEMP_MAIL_ANY_DOMAIN) {
    return pickRandomDomain(domains);
  }

  return normalizeTempMailDomainSelection(config.domain, domains);
}
