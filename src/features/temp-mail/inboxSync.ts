import { DuckProfile } from "../../shared/types/profile";
import {
  TempMailInbox,
  TempMailMessageQuery,
  getTempMailConfiguredDomains,
  normalizeTempMailDomainSelection
} from "../../shared/types/tempMail";
import { MailSummary } from "../../shared/types/mail";
import {
  fetchTempMailAdminMessageSummaryPage,
  fetchTempMailMessageSummaryPage,
  fetchTempMailUserTokenMessageSummaryPage
} from "./client";

export type CurrentInboxSyncResult = {
  inbox: TempMailInbox;
  messages: MailSummary[];
  totalCount: number | null;
  source: "address_api" | "admin_api" | "user_token_api";
};

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function extractInboxDomain(address: string) {
  const trimmed = address.trim();
  const match = trimmed.match(/@([^@\s]+)$/);
  return match?.[1]?.trim() || "";
}

function inferTempMailBaseUrl(address: string, fallback: string) {
  if (fallback.trim()) {
    return normalizeUrl(fallback);
  }

  const domain = extractInboxDomain(address);
  if (!domain) {
    return "";
  }

  if (domain.startsWith("temp-email.")) {
    return `https://${domain}`;
  }

  return `https://temp-email.${domain}`;
}

export function normalizeProfileForCurrentInboxSync(profile: DuckProfile): DuckProfile {
  const address = profile.inbox?.address || "";
  const inferredDomain = extractInboxDomain(address);
  const inferredBaseUrl = inferTempMailBaseUrl(address, profile.tempMail.baseUrl);
  const inferredDomains = getTempMailConfiguredDomains(profile.tempMail);
  const nextDomains =
    inferredDomains.length > 0
      ? inferredDomains
      : inferredDomain
        ? [inferredDomain]
        : [];

  return {
    ...profile,
    tempMail: {
      ...profile.tempMail,
      baseUrl: inferredBaseUrl,
      domains: nextDomains,
      domain: normalizeTempMailDomainSelection(
        profile.tempMail.domain,
        nextDomains,
        inferredDomain
      )
    }
  };
}

export async function fetchCurrentInboxMessageSummaryPage(
  profile: DuckProfile,
  query: TempMailMessageQuery = {}
): Promise<CurrentInboxSyncResult> {
  const normalizedProfile = normalizeProfileForCurrentInboxSync(profile);
  const inbox = normalizedProfile.inbox;
  if (!inbox?.address.trim()) {
    throw new Error("请先创建或填写收件箱信息。");
  }

  if (!normalizedProfile.tempMail.baseUrl.trim()) {
    throw new Error("请先填写 Temp Mail Base URL。");
  }

  if (inbox.addressJwt.trim()) {
    const session = {
      ...normalizedProfile.tempMail,
      ...inbox
    };
    const result = await fetchTempMailMessageSummaryPage(session, query);

    return {
      inbox,
      messages: result.messages,
      totalCount: result.totalCount,
      source: "address_api"
    };
  }

  if (normalizedProfile.mode === "tempmail" && normalizedProfile.tempMail.adminAuth.trim()) {
    const result = await fetchTempMailAdminMessageSummaryPage(
      normalizedProfile.tempMail,
      inbox.address,
      {
        ...query,
        address: inbox.address
      }
    );

    return {
      inbox,
      messages: result.messages,
      totalCount: result.totalCount,
      source: "admin_api"
    };
  }

  if (normalizedProfile.mode === "tempmail" && normalizedProfile.tempMail.customAuth.trim()) {
    const result = await fetchTempMailUserTokenMessageSummaryPage(
      normalizedProfile.tempMail,
      inbox.address,
      {
        ...query,
        address: inbox.address
      }
    );

    return {
      inbox,
      messages: result.messages,
      totalCount: result.totalCount,
      source: "user_token_api"
    };
  }

  if (normalizedProfile.mode === "duck") {
    throw new Error("当前 Duck 收件箱缺少 JWT，无法同步邮件。");
  }

  throw new Error("当前邮箱没有 JWT，且未配置 Admin Auth 或 User Token，无法同步邮件。");
}
