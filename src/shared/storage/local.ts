import { DEFAULT_DUCK_CONFIG, DEFAULT_TEMP_MAIL_CONFIG } from "../config/defaults";
import { DuckAlias, DuckConfig } from "../types/duck";
import { MailSummary } from "../types/mail";
import { DuckProfile, ProfileMode } from "../types/profile";
import { TempMailConfig, TempMailInbox } from "../types/tempMail";
import { STORAGE_KEYS } from "./keys";

type StorageValue =
  | DuckConfig
  | TempMailConfig
  | TempMailInbox
  | DuckAlias[]
  | MailSummary[]
  | DuckProfile[]
  | string
  | null;

export type PopupTheme = "dark" | "light";

async function getValue<T extends StorageValue>(key: string): Promise<T | null> {
  const result = await chrome.storage.local.get(key);
  return (result[key] as T | undefined) ?? null;
}

async function setValue<T extends StorageValue>(key: string, value: T) {
  if (value === null) {
    await chrome.storage.local.remove(key);
    return;
  }

  await chrome.storage.local.set({ [key]: value });
}

function createProfileId() {
  return `duck-${crypto.randomUUID()}`;
}

export function createEmptyProfile(name?: string): DuckProfile {
  const now = new Date().toISOString();

  return {
    id: createProfileId(),
    name: name || `Duck ${new Date().toLocaleDateString()}`,
    mode: "duck",
    duck: { ...DEFAULT_DUCK_CONFIG },
    tempMail: { ...DEFAULT_TEMP_MAIL_CONFIG },
    inbox: null,
    aliases: [],
    currentAliasId: null,
    messages: [],
    readMessageIds: [],
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeProfiles(profiles: DuckProfile[]): DuckProfile[] {
  return profiles.map((profile): DuckProfile => {
    const mode: ProfileMode = profile.mode === "tempmail" ? "tempmail" : "duck";

    return {
      ...profile,
      mode,
      readMessageIds: Array.isArray(profile.readMessageIds) ? profile.readMessageIds : []
    };
  });
}

async function migrateLegacyProfiles() {
  const [duckConfig, tempMailConfig, tempMailInbox, aliases, messages] = await Promise.all([
    getValue<DuckConfig>(STORAGE_KEYS.duckConfig),
    getValue<TempMailConfig>(STORAGE_KEYS.tempMailConfig),
    getValue<TempMailInbox>(STORAGE_KEYS.tempMailInbox),
    getValue<DuckAlias[]>(STORAGE_KEYS.aliases),
    getValue<MailSummary[]>(STORAGE_KEYS.messages)
  ]);

  const hasLegacyData =
    !!duckConfig ||
    !!tempMailConfig ||
    !!tempMailInbox ||
    (aliases?.length ?? 0) > 0 ||
    (messages?.length ?? 0) > 0;

  if (!hasLegacyData) {
    return [];
  }

  const profile = createEmptyProfile("默认 Duck");
  profile.duck = duckConfig || { ...DEFAULT_DUCK_CONFIG };
  profile.tempMail = tempMailConfig || { ...DEFAULT_TEMP_MAIL_CONFIG };
  profile.mode = "duck";
  profile.inbox = tempMailInbox || null;
  profile.aliases = aliases || [];
  profile.currentAliasId = profile.aliases[0]?.id ?? null;
  profile.messages = messages || [];
  profile.readMessageIds = [];
  profile.lastSyncedAt = profile.messages.length ? new Date().toISOString() : null;

  await setValue(STORAGE_KEYS.profiles, [profile]);
  await setValue(STORAGE_KEYS.activeProfileId, profile.id);

  return [profile];
}

export async function loadProfiles() {
  const profiles = await getValue<DuckProfile[]>(STORAGE_KEYS.profiles);

  if (profiles?.length) {
    return normalizeProfiles(profiles);
  }

  return migrateLegacyProfiles();
}

export async function saveProfiles(profiles: DuckProfile[]) {
  await setValue(STORAGE_KEYS.profiles, normalizeProfiles(profiles));
}

export async function loadActiveProfileId() {
  return getValue<string>(STORAGE_KEYS.activeProfileId);
}

export async function saveActiveProfileId(profileId: string | null) {
  await setValue(STORAGE_KEYS.activeProfileId, profileId);
}

export async function loadPopupTheme() {
  const theme = await getValue<string>(STORAGE_KEYS.popupTheme);
  return theme === "light" ? "light" : "dark";
}

export async function savePopupTheme(theme: PopupTheme) {
  await setValue(STORAGE_KEYS.popupTheme, theme);
}
