import { DuckAlias, DuckConfig } from "./duck";
import { MailSummary } from "./mail";
import { TempMailConfig, TempMailInbox } from "./tempMail";

export type DuckProfile = {
  id: string;
  name: string;
  duck: DuckConfig;
  tempMail: TempMailConfig;
  inbox: TempMailInbox | null;
  aliases: DuckAlias[];
  currentAliasId: string | null;
  messages: MailSummary[];
  readMessageIds: string[];
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
