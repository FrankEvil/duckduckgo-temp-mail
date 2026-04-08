import {
  fetchCurrentInboxMessageSummaryPage,
  normalizeProfileForCurrentInboxSync
} from "../features/temp-mail/inboxSync";
import { loadActiveProfileId, loadProfiles, saveProfiles } from "../shared/storage/local";
import { DuckProfile } from "../shared/types/profile";
import { TempMailInbox } from "../shared/types/tempMail";

const AUTO_REFRESH_ALARM = "duck-temp-mail-auto-refresh";
const AUTO_REFRESH_MINUTES_FLOOR = 0.5;
const AUTO_REFRESH_PAGE_SIZE = 20;

let refreshInFlight = false;

function sameTempMailInbox(left: TempMailInbox | null | undefined, right: TempMailInbox | null | undefined) {
  if (!left || !right) {
    return false;
  }

  return (
    (left.addressJwt && right.addressJwt && left.addressJwt === right.addressJwt) ||
    (!!left.address && !!right.address && left.address === right.address)
  );
}

function buildAlarmPeriodMinutes(intervalMs: number) {
  return Math.max(intervalMs / 60000, AUTO_REFRESH_MINUTES_FLOOR);
}

function canAutoRefreshProfile(profile: DuckProfile | null | undefined) {
  if (!profile?.tempMail.autoRefreshEnabled) {
    return false;
  }

  const normalizedProfile = normalizeProfileForCurrentInboxSync(profile);

  if (!normalizedProfile.inbox?.address.trim()) {
    return false;
  }

  if (!normalizedProfile.tempMail.baseUrl.trim()) {
    return false;
  }

  if (normalizedProfile.inbox.addressJwt.trim()) {
    return true;
  }

  return (
    normalizedProfile.mode === "tempmail" &&
    (!!normalizedProfile.tempMail.adminAuth.trim() ||
      !!normalizedProfile.tempMail.customAuth.trim())
  );
}

function applyCurrentInboxMessages(
  profile: DuckProfile,
  messages: DuckProfile["messages"],
  totalCount: number | null
) {
  const inbox = profile.inbox;
  if (!inbox) {
    return profile;
  }

  const currentState =
    profile.tempMailInboxStates.find((state) => sameTempMailInbox(state.inbox, inbox)) || {
      inbox,
      messages: profile.messages,
      messageTotal: profile.messageTotal,
      readMessageIds: profile.readMessageIds,
      lastSyncedAt: profile.lastSyncedAt
    };

  const nextState = {
    ...currentState,
    inbox,
    messages,
    messageTotal: totalCount ?? messages.length,
    readMessageIds: Array.from(new Set(currentState.readMessageIds)),
    lastSyncedAt: new Date().toISOString()
  };

  return {
    ...profile,
    tempMailInboxes: [inbox, ...profile.tempMailInboxes.filter((item) => !sameTempMailInbox(item, inbox))],
    tempMailInboxStates: [
      nextState,
      ...profile.tempMailInboxStates.filter((state) => !sameTempMailInbox(state.inbox, inbox))
    ],
    messages: nextState.messages,
    messageTotal: nextState.messageTotal,
    readMessageIds: nextState.readMessageIds,
    lastSyncedAt: nextState.lastSyncedAt,
    updatedAt: new Date().toISOString()
  };
}

async function syncAutoRefreshAlarm() {
  const [profiles, activeProfileId] = await Promise.all([loadProfiles(), loadActiveProfileId()]);
  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) || profiles[0] || null;

  if (!activeProfile || !canAutoRefreshProfile(activeProfile)) {
    await chrome.alarms.clear(AUTO_REFRESH_ALARM);
    return;
  }

  chrome.alarms.create(AUTO_REFRESH_ALARM, {
    delayInMinutes: buildAlarmPeriodMinutes(activeProfile.tempMail.pollIntervalMs),
    periodInMinutes: buildAlarmPeriodMinutes(activeProfile.tempMail.pollIntervalMs)
  });
}

async function refreshActiveProfileCurrentInbox() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;

  try {
    const [profiles, activeProfileId] = await Promise.all([loadProfiles(), loadActiveProfileId()]);
    const activeProfile =
      profiles.find((profile) => profile.id === activeProfileId) || profiles[0] || null;

    if (!activeProfile || !canAutoRefreshProfile(activeProfile)) {
      await chrome.alarms.clear(AUTO_REFRESH_ALARM);
      return;
    }

    const normalizedProfile = normalizeProfileForCurrentInboxSync(activeProfile);
    const { messages, totalCount } = await fetchCurrentInboxMessageSummaryPage(normalizedProfile, {
      limit: AUTO_REFRESH_PAGE_SIZE,
      offset: 0
    });

    const nextProfiles = profiles.map((profile) =>
      profile.id === activeProfile.id
        ? applyCurrentInboxMessages(normalizedProfile, messages, totalCount)
        : profile
    );

    await saveProfiles(nextProfiles);
  } catch (error) {
    console.warn("DuckDuckGo Temp Mail auto refresh failed.", error);
  } finally {
    refreshInFlight = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.info("DuckDuckGo Temp Mail extension installed.");
  void syncAutoRefreshAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void syncAutoRefreshAlarm();
});

chrome.storage.onChanged.addListener(() => {
  void syncAutoRefreshAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_REFRESH_ALARM) {
    return;
  }

  void refreshActiveProfileCurrentInbox();
});
