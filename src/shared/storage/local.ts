import { DEFAULT_DUCK_CONFIG, DEFAULT_TEMP_MAIL_CONFIG } from "../config/defaults";
import { DuckAlias, DuckConfig } from "../types/duck";
import { MailSummary } from "../types/mail";
import { DuckProfile, ProfileMode, TempMailInboxState } from "../types/profile";
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
    tempMailInboxes: [],
    tempMailInboxStates: [],
    aliases: [],
    currentAliasId: null,
    messages: [],
    messageTotal: 0,
    readMessageIds: [],
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function sameInbox(left: TempMailInbox | null | undefined, right: TempMailInbox | null | undefined) {
  if (!left || !right) {
    return false;
  }

  return (
    (left.addressJwt && right.addressJwt && left.addressJwt === right.addressJwt) ||
    (!!left.address && !!right.address && left.address === right.address)
  );
}

function normalizeTempMailInboxes(
  inboxes: TempMailInbox[] | undefined,
  currentInbox: TempMailInbox | null
) {
  const normalizedInboxes = Array.isArray(inboxes)
    ? inboxes.filter(
        (inbox): inbox is TempMailInbox =>
          !!inbox &&
          typeof inbox.address === "string" &&
          typeof inbox.addressJwt === "string" &&
          typeof inbox.createdAt === "string"
      )
    : [];

  if (currentInbox && !normalizedInboxes.some((inbox) => sameInbox(inbox, currentInbox))) {
    normalizedInboxes.unshift(currentInbox);
  }

  return normalizedInboxes.filter(
    (inbox, index, list) => list.findIndex((item) => sameInbox(item, inbox)) === index
  );
}

function normalizeMessages(messages: MailSummary[] | undefined) {
  return Array.isArray(messages) ? messages : [];
}

function normalizeReadMessageIds(readMessageIds: string[] | undefined) {
  return Array.isArray(readMessageIds) ? readMessageIds : [];
}

function buildInboxState(
  inbox: TempMailInbox,
  partial?: Partial<TempMailInboxState>
): TempMailInboxState {
  return {
    inbox,
    messages: normalizeMessages(partial?.messages),
    messageTotal:
      typeof partial?.messageTotal === "number" && partial.messageTotal >= 0
        ? partial.messageTotal
        : normalizeMessages(partial?.messages).length,
    readMessageIds: normalizeReadMessageIds(partial?.readMessageIds),
    lastSyncedAt: typeof partial?.lastSyncedAt === "string" ? partial.lastSyncedAt : null
  };
}

function normalizeTempMailInboxStates(profile: DuckProfile, currentInbox: TempMailInbox | null) {
  const rawStates = Array.isArray(profile.tempMailInboxStates) ? profile.tempMailInboxStates : [];
  const normalizedStates = rawStates
    .map((state) => {
      if (!state?.inbox || typeof state !== "object") {
        return null;
      }

      const inbox =
        typeof state.inbox.address === "string" &&
        typeof state.inbox.addressJwt === "string" &&
        typeof state.inbox.createdAt === "string"
          ? state.inbox
          : null;

      if (!inbox) {
        return null;
      }

      return buildInboxState(inbox, state);
    })
    .filter((state): state is TempMailInboxState => !!state);

  if (currentInbox) {
    const currentState = buildInboxState(currentInbox, {
      messages: profile.messages,
      messageTotal: profile.messageTotal,
      readMessageIds: profile.readMessageIds,
      lastSyncedAt: profile.lastSyncedAt
    });
    const existingIndex = normalizedStates.findIndex((state) => sameInbox(state.inbox, currentInbox));

    if (existingIndex >= 0) {
      normalizedStates.splice(existingIndex, 1, currentState);
    } else {
      normalizedStates.unshift(currentState);
    }
  }

  return normalizedStates.filter(
    (state, index, list) =>
      list.findIndex((item) => sameInbox(item.inbox, state.inbox)) === index
  );
}

function normalizeProfiles(profiles: DuckProfile[]): DuckProfile[] {
  return profiles.map((profile): DuckProfile => {
    const mode: ProfileMode = profile.mode === "tempmail" ? "tempmail" : "duck";
    const inbox =
      profile.inbox &&
      typeof profile.inbox.address === "string" &&
      typeof profile.inbox.addressJwt === "string" &&
      typeof profile.inbox.createdAt === "string"
        ? profile.inbox
        : null;
    const tempMailInboxStates = normalizeTempMailInboxStates(profile, inbox);
    const currentInboxState =
      (inbox && tempMailInboxStates.find((state) => sameInbox(state.inbox, inbox))) || null;

    return {
      ...profile,
      mode,
      inbox,
      tempMailInboxes: normalizeTempMailInboxes(profile.tempMailInboxes, inbox),
      tempMailInboxStates,
      messages: currentInboxState ? currentInboxState.messages : normalizeMessages(profile.messages),
      messageTotal: currentInboxState
        ? currentInboxState.messageTotal
        : typeof profile.messageTotal === "number" && profile.messageTotal >= 0
          ? profile.messageTotal
          : normalizeMessages(profile.messages).length,
      readMessageIds: currentInboxState
        ? currentInboxState.readMessageIds
        : normalizeReadMessageIds(profile.readMessageIds),
      lastSyncedAt: currentInboxState ? currentInboxState.lastSyncedAt : profile.lastSyncedAt
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
  profile.tempMailInboxes = tempMailInbox ? [tempMailInbox] : [];
  profile.tempMailInboxStates = tempMailInbox
    ? [
        {
          inbox: tempMailInbox,
          messages: messages || [],
          messageTotal: (messages || []).length,
          readMessageIds: [],
          lastSyncedAt: (messages || []).length ? new Date().toISOString() : null
        }
      ]
    : [];
  profile.aliases = aliases || [];
  profile.currentAliasId = profile.aliases[0]?.id ?? null;
  profile.messages = messages || [];
  profile.messageTotal = profile.messages.length;
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
