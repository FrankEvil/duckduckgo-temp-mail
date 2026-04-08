import { DuckConfig } from "../types/duck";
import { TempMailConfig } from "../types/tempMail";

export const DEFAULT_DUCK_CONFIG: DuckConfig = {
  apiBaseUrl: "https://quack.duckduckgo.com",
  token: "",
  aliasDomain: "duck.com"
};

export const DEFAULT_TEMP_MAIL_CONFIG: TempMailConfig = {
  baseUrl: "",
  adminAuth: "",
  customAuth: "",
  domain: "",
  domains: [],
  autoRefreshEnabled: false,
  enablePrefix: true,
  namePrefix: "duckrelay-",
  pollIntervalMs: 5000,
  pollTimeoutMs: 120000
};
