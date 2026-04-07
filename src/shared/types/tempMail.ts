import { MailSummary } from "./mail";

export type TempMailConfig = {
  baseUrl: string;
  adminAuth: string;
  customAuth: string;
  domain: string;
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
};

export type TempMailMessagePage = {
  messages: TempMailMessage[];
  totalCount: number | null;
};

export type TempMailMailboxSession = TempMailConfig & TempMailInbox;

export type TempMailMessageSummary = MailSummary;
