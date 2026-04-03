export type DuckConfig = {
  apiBaseUrl: string;
  token: string;
  aliasDomain: string;
};

export type DuckAlias = {
  id: string;
  address: string;
  createdAt: string;
  status: "active" | "inactive";
  source: "duckduckgo";
};
