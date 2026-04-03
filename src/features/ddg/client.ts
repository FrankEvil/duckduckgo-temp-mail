import { DuckAlias, DuckConfig } from "../../shared/types/duck";

const DEFAULT_DDG_API_BASE_URL = "https://quack.duckduckgo.com";

type CreateDuckAliasResponse = {
  address?: string;
};

function joinUrl(baseUrl: string, pathname: string) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

  return new URL(normalizedPath, normalizedBaseUrl).toString();
}

export async function createDuckAlias(config: DuckConfig): Promise<DuckAlias> {
  const response = await fetch(
    joinUrl(config.apiBaseUrl || DEFAULT_DDG_API_BASE_URL, "/api/email/addresses"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    }
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo alias creation failed: ${response.status}`);
  }

  const data = (await response.json()) as CreateDuckAliasResponse;
  const localPart = data.address;

  if (!localPart) {
    throw new Error("DuckDuckGo alias creation failed: missing address.");
  }

  return {
    id: `${localPart}@${config.aliasDomain}`,
    address: `${localPart}@${config.aliasDomain}`,
    createdAt: new Date().toISOString(),
    status: "active",
    source: "duckduckgo"
  };
}

export async function listDuckAliases(_config: DuckConfig): Promise<DuckAlias[]> {
  return [];
}
