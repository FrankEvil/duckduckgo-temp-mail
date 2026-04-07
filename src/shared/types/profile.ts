import { DuckAlias, DuckConfig } from "./duck";
import { MailSummary } from "./mail";
import { TempMailConfig, TempMailInbox } from "./tempMail";

export type ProfileMode = "duck" | "tempmail";

export type TempMailInboxState = {
  inbox: TempMailInbox;
  messages: MailSummary[];
  messageTotal: number;
  readMessageIds: string[];
  lastSyncedAt: string | null;
};

export type DuckProfile = {
  id: string;
  name: string;
  mode: ProfileMode;
  duck: DuckConfig;
  tempMail: TempMailConfig;
  inbox: TempMailInbox | null;
  tempMailInboxes: TempMailInbox[];
  tempMailInboxStates: TempMailInboxState[];
  aliases: DuckAlias[];
  currentAliasId: string | null;
  messages: MailSummary[];
  messageTotal: number;
  readMessageIds: string[];
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
