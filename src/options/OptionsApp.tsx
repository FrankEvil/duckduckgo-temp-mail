import { useEffect, useMemo, useRef, useState } from "react";

import { createDuckAlias } from "../features/ddg/client";
import {
  createTempMailInbox,
  fetchTempMailAdminMessageSummaryPage,
  fetchTempMailMessageSummaryPage
} from "../features/temp-mail/client";
import {
  EmailHtmlFrame,
  extractMailbox,
  normalizePlainTextContent
} from "../shared/components/EmailHtmlFrame";
import {
  PopupTheme,
  createEmptyProfile,
  loadActiveProfileId,
  loadPopupTheme,
  loadProfiles,
  saveActiveProfileId,
  savePopupTheme,
  saveProfiles
} from "../shared/storage/local";
import { DuckAlias } from "../shared/types/duck";
import { MailSummary } from "../shared/types/mail";
import { DuckProfile, ProfileMode, TempMailInboxState } from "../shared/types/profile";
import { TempMailInbox } from "../shared/types/tempMail";

type Notice = {
  type: "success" | "error" | "info";
  message: string;
};

type BusyAction = "save" | "alias" | "inbox" | "sync" | "delete" | null;
type PanelView = "edit" | "status";
type MessageViewMode = "html" | "text";
type MailScope = "current" | "all";

const MESSAGE_PAGE_SIZE = 20;

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function parseNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function updateProfileTimestamp(profile: DuckProfile) {
  return {
    ...profile,
    updatedAt: new Date().toISOString()
  };
}

function mergeAlias(profile: DuckProfile, newAlias: DuckAlias): DuckProfile {
  return updateProfileTimestamp({
    ...profile,
    aliases: [newAlias, ...profile.aliases.filter((item) => item.id !== newAlias.id)],
    currentAliasId: newAlias.id
  });
}

function sameTempMailInbox(left: TempMailInbox | null | undefined, right: TempMailInbox | null | undefined) {
  if (!left || !right) {
    return false;
  }

  return (
    (left.addressJwt && right.addressJwt && left.addressJwt === right.addressJwt) ||
    (!!left.address && !!right.address && left.address === right.address)
  );
}

function mergeTempMailInboxes(currentInboxes: TempMailInbox[], inbox: TempMailInbox) {
  return [inbox, ...currentInboxes.filter((item) => !sameTempMailInbox(item, inbox))];
}

function buildTempMailInboxState(
  inbox: TempMailInbox,
  partial?: Partial<TempMailInboxState>
): TempMailInboxState {
  return {
    inbox,
    messages: partial?.messages || [],
    messageTotal:
      typeof partial?.messageTotal === "number" && partial.messageTotal >= 0
        ? partial.messageTotal
        : (partial?.messages || []).length,
    readMessageIds: partial?.readMessageIds || [],
    lastSyncedAt: partial?.lastSyncedAt || null
  };
}

function getCurrentTempMailInboxState(profile: DuckProfile) {
  if (!profile.inbox) {
    return null;
  }

  return (
    profile.tempMailInboxStates.find((state) => sameTempMailInbox(state.inbox, profile.inbox)) ||
    buildTempMailInboxState(profile.inbox, {
      messages: profile.messages,
      messageTotal: profile.messageTotal,
      readMessageIds: profile.readMessageIds,
      lastSyncedAt: profile.lastSyncedAt
    })
  );
}

function syncCurrentTempMailInboxState(
  profile: DuckProfile,
  updater: (state: TempMailInboxState) => TempMailInboxState
) {
  if (profile.mode !== "tempmail" || !profile.inbox) {
    const fallbackState = updater(
      buildTempMailInboxState(
        {
          address: "",
          addressJwt: "",
          createdAt: new Date().toISOString()
        },
        {
          messages: profile.messages,
          messageTotal: profile.messageTotal,
          readMessageIds: profile.readMessageIds,
          lastSyncedAt: profile.lastSyncedAt
        }
      )
    );

    return updateProfileTimestamp({
      ...profile,
      messages: fallbackState.messages,
      messageTotal: fallbackState.messageTotal,
      readMessageIds: fallbackState.readMessageIds,
      lastSyncedAt: fallbackState.lastSyncedAt
    });
  }

  const currentState = getCurrentTempMailInboxState(profile) || buildTempMailInboxState(profile.inbox);
  const nextState = updater(currentState);
  const nextStates = [
    nextState,
    ...profile.tempMailInboxStates.filter((state) => !sameTempMailInbox(state.inbox, profile.inbox))
  ];

  return updateProfileTimestamp({
    ...profile,
    tempMailInboxes: mergeTempMailInboxes(profile.tempMailInboxes, nextState.inbox),
    tempMailInboxStates: nextStates,
    messages: nextState.messages,
    messageTotal: nextState.messageTotal,
    readMessageIds: nextState.readMessageIds,
    lastSyncedAt: nextState.lastSyncedAt
  });
}

function applyTempMailInbox(profile: DuckProfile, inbox: TempMailInbox) {
  const matchedState =
    profile.tempMailInboxStates.find((state) => sameTempMailInbox(state.inbox, inbox)) ||
    buildTempMailInboxState(inbox);

  return updateProfileTimestamp({
    ...profile,
    inbox,
    tempMailInboxes: mergeTempMailInboxes(profile.tempMailInboxes, inbox),
    tempMailInboxStates: [
      matchedState,
      ...profile.tempMailInboxStates.filter((state) => !sameTempMailInbox(state.inbox, inbox))
    ],
    messages: matchedState.messages,
    messageTotal: matchedState.messageTotal,
    readMessageIds: matchedState.readMessageIds,
    lastSyncedAt: matchedState.lastSyncedAt
  });
}

function getSelectedProfile(profiles: DuckProfile[], selectedProfileId: string | null) {
  return profiles.find((item) => item.id === selectedProfileId) ?? profiles[0] ?? null;
}

function getModeLabel(mode: ProfileMode) {
  return mode === "duck" ? "DuckDuckGo 转发" : "Temp Mail 直连";
}

function getActiveAlias(profile: DuckProfile) {
  return (
    profile.aliases.find((item) => item.id === profile.currentAliasId) ||
    profile.aliases[0] ||
    null
  );
}

function getProfileAddress(profile: DuckProfile) {
  if (profile.mode === "duck") {
    return getActiveAlias(profile)?.address || "尚未生成 Duck 地址";
  }

  return profile.inbox?.address || "尚未创建收件箱";
}

function getProfileSummaryLine(profile: DuckProfile) {
  if (profile.mode === "duck") {
    return getActiveAlias(profile)?.address || "Duck token + Temp Mail 收件箱";
  }

  return profile.inbox?.address || "Temp Mail 直连";
}

function getTempMailInboxHistory(profile: DuckProfile) {
  return profile.tempMailInboxes.length
    ? profile.tempMailInboxes
    : profile.inbox
      ? [profile.inbox]
      : [];
}

function getTempMailHistoryOptions(profile: DuckProfile) {
  return getTempMailInboxHistory(profile).map((inbox) => ({
    value: inbox.addressJwt || inbox.address,
    inbox
  }));
}

function getUnreadCount(profile: DuckProfile) {
  return profile.messages.filter((message) => !profile.readMessageIds.includes(message.id)).length;
}

function buildScopedMessageId(inbox: TempMailInbox, messageId: string) {
  return `${inbox.addressJwt || inbox.address}::${messageId}`;
}

function getStatusMailScopeData(profile: DuckProfile, scope: MailScope) {
  if (profile.mode !== "tempmail" || scope === "current") {
    const total = profile.messageTotal > 0 ? profile.messageTotal : profile.messages.length;
    return {
      messages: profile.messages,
      readMessageIds: profile.readMessageIds,
      loadedCount: profile.messages.length,
      totalCount: total,
      unreadCount: getUnreadCount(profile),
      lastSyncedAt: profile.lastSyncedAt,
      hasMore: false,
      showRecipientAddress: false
    };
  }

  const allStates = profile.tempMailInboxStates;
  const scopedMessages = allStates
    .flatMap((state) =>
      state.messages.map((message) => ({
        ...message,
        id: buildScopedMessageId(state.inbox, message.id),
        recipientAddress: message.recipientAddress || state.inbox.address,
        address: state.inbox.address
      }))
    )
    .sort((left, right) => {
      const leftTime = new Date(left.receivedAt).getTime();
      const rightTime = new Date(right.receivedAt).getTime();
      return rightTime - leftTime;
    });

  const scopedReadMessageIds = allStates.flatMap((state) =>
    state.readMessageIds.map((messageId) => buildScopedMessageId(state.inbox, messageId))
  );
  const loadedCount = allStates.reduce((total, state) => total + state.messages.length, 0);
  const totalCount = allStates.reduce(
    (total, state) => total + (state.messageTotal > 0 ? state.messageTotal : state.messages.length),
    0
  );
  const unreadCount = allStates.reduce(
    (total, state) =>
      total +
      state.messages.filter((message) => !state.readMessageIds.includes(message.id)).length,
    0
  );
  const syncedAtList = allStates
    .map((state) => state.lastSyncedAt)
    .filter((value): value is string => !!value)
    .sort();
  const lastSyncedAt = syncedAtList.length ? syncedAtList[syncedAtList.length - 1] : null;

  return {
    messages: scopedMessages,
    readMessageIds: scopedReadMessageIds,
    loadedCount,
    totalCount,
    unreadCount,
    lastSyncedAt,
    hasMore: false,
    showRecipientAddress: true
  };
}

function formatAbsoluteDateTime(value: string | null) {
  if (!value) {
    return "未同步";
  }

  const plainMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
  );

  if (plainMatch) {
    const [, year, month, day, hour, minute, second] = plainMatch;
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
    .format(date)
    .replace(/\//g, "-");
}

function formatListDateTime(value: string) {
  const absolute = formatAbsoluteDateTime(value);
  const match = absolute.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);

  if (!match) {
    return {
      date: "",
      time: absolute
    };
  }

  return {
    date: match[1],
    time: match[2]
  };
}

function buildInboxPatch(existingInbox: TempMailInbox | null, partial: Partial<TempMailInbox>) {
  return {
    address: partial.address ?? existingInbox?.address ?? "",
    addressJwt: partial.addressJwt ?? existingInbox?.addressJwt ?? "",
    createdAt: partial.createdAt ?? existingInbox?.createdAt ?? new Date().toISOString()
  };
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

function patchDuckProfileTempMailFromInbox(profile: DuckProfile) {
  if (profile.mode !== "duck") {
    return profile;
  }

  const address = profile.inbox?.address || "";
  const inferredDomain = extractInboxDomain(address);
  const inferredBaseUrl = inferTempMailBaseUrl(address, profile.tempMail.baseUrl);

  return {
    ...profile,
    tempMail: {
      ...profile.tempMail,
      baseUrl: inferredBaseUrl,
      domain: profile.tempMail.domain.trim() || inferredDomain
    }
  };
}

function mergeMailSummaries(currentMessages: MailSummary[], incomingMessages: MailSummary[]) {
  const mergedMessages = [...currentMessages];
  const knownMessageIds = new Set(currentMessages.map((message) => message.id));

  for (const message of incomingMessages) {
    if (knownMessageIds.has(message.id)) {
      continue;
    }

    mergedMessages.push(message);
    knownMessageIds.add(message.id);
  }

  return mergedMessages;
}

function mergeReadMessageIds(currentReadMessageIds: string[], incomingReadMessageIds: string[] = []) {
  return Array.from(new Set([...currentReadMessageIds, ...incomingReadMessageIds]));
}

function getHasMoreMessages(totalCount: number, loadedCount: number, lastPageCount: number) {
  if (totalCount > 0) {
    return loadedCount < totalCount;
  }

  return lastPageCount >= MESSAGE_PAGE_SIZE;
}

function StatusMailList({
  messages,
  readMessageIds,
  theme,
  hasMore,
  loadingMore,
  onLoadMore,
  onSelectMessage,
  showRecipientAddress = false
}: {
  messages: MailSummary[];
  readMessageIds: string[];
  theme: PopupTheme;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onSelectMessage: (messageId: string) => void;
  showRecipientAddress?: boolean;
}) {
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(messages[0]?.id || null);
  const [messageViewModes, setMessageViewModes] = useState<Record<string, MessageViewMode>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadLockRef = useRef(false);

  useEffect(() => {
    setMessageViewModes((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([messageId]) =>
          messages.some((message) => message.id === messageId)
        )
      )
    );
  }, [messages]);

  useEffect(() => {
    setSelectedMessageId((current) =>
      current && messages.some((message) => message.id === current) ? current : messages[0]?.id || null
    );
  }, [messages]);

  useEffect(() => {
    if (!loadingMore) {
      autoLoadLockRef.current = false;
    }
  }, [loadingMore]);

  useEffect(() => {
    const root = listRef.current;
    const sentinel = loadMoreSentinelRef.current;

    if (!root || !sentinel || !hasMore || loadingMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        if (autoLoadLockRef.current) {
          return;
        }

        autoLoadLockRef.current = true;
        void onLoadMore();
      },
      {
        root,
        rootMargin: "160px 0px",
        threshold: 0.01
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore, messages.length]);

  if (!messages.length) {
    return (
      <div className="mode-empty-state">
        当前还没有同步到邮件。进入状态页后可以直接点“立即同步”查看最新内容。
      </div>
    );
  }

  const selectedMessage =
    messages.find((message) => message.id === selectedMessageId) || messages[0] || null;

  if (!selectedMessage) {
    return null;
  }

  const selectedHasHtmlContent = Boolean(selectedMessage.htmlContent?.trim());
  const selectedTextContent = normalizePlainTextContent(
    selectedMessage.content || selectedMessage.raw || selectedMessage.preview || "暂无正文"
  );
  const selectedViewMode = selectedHasHtmlContent
    ? messageViewModes[selectedMessage.id] || "html"
    : "text";

  return (
    <div className="mode-mail-browser">
      <div className="mode-mail-list-pane">
        <div ref={listRef} className="mode-mail-list">
          {messages.map((message) => {
            const datetime = formatListDateTime(message.receivedAt);
            const isUnread = !readMessageIds.includes(message.id);

            return (
              <article
                key={message.id}
                role="button"
                tabIndex={0}
                className={`mode-mail-card mode-mail-list-card ${isUnread ? "is-unread" : ""} ${
                  selectedMessage.id === message.id ? "is-active" : ""
                }`}
                onClick={() => {
                  setSelectedMessageId(message.id);
                  onSelectMessage(message.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedMessageId(message.id);
                    onSelectMessage(message.id);
                  }
                }}
                aria-pressed={selectedMessage.id === message.id}
              >
                <div className="mode-mail-list-head">
                  <div className="mode-mail-list-titleline">
                    <div className="mode-mail-list-title">{message.subject || "无主题"}</div>
                    {isUnread ? <span className="mode-mail-unread-dot" aria-hidden="true"></span> : null}
                  </div>
                  <div className="mode-mail-list-date">
                    {datetime.date ? <span>{datetime.date}</span> : null}
                    <strong>{datetime.time}</strong>
                  </div>
                </div>
                <div className="mode-mail-list-from">
                  {extractMailbox(message.sourceAddress || message.from || "未知发件人")}
                </div>
                {showRecipientAddress ? (
                  <div className="mode-mail-list-recipient">
                    {message.recipientAddress || message.address || "未知收件箱"}
                  </div>
                ) : null}
                <div className="mode-mail-list-preview">{message.preview || "暂无摘要"}</div>
              </article>
            );
          })}
          <div ref={loadMoreSentinelRef} className="mode-mail-list-sentinel" aria-hidden="true"></div>
        </div>
        {hasMore || loadingMore ? (
          <div className="mode-mail-more">
            <span>{loadingMore ? "正在自动加载更多..." : "滚动到底部后自动加载更多"}</span>
          </div>
        ) : null}
      </div>

      <div className="mode-mail-reader">
        <div className="mode-mail-reader-head">
          <div>
            <h4 className="mode-mail-reader-title">{selectedMessage.subject || "无主题"}</h4>
            <div className="mode-mail-reader-from">
              {extractMailbox(selectedMessage.sourceAddress || selectedMessage.from || "未知发件人")}
            </div>
          </div>
          <div className="mode-mail-side">
            {(() => {
              const datetime = formatListDateTime(selectedMessage.receivedAt);
              return (
                <>
                  {datetime.date ? <span>{datetime.date}</span> : null}
                  <strong>{datetime.time}</strong>
                </>
              );
            })()}
          </div>
        </div>

        <div className="mode-mail-route">
          <span>{extractMailbox(selectedMessage.sourceAddress || selectedMessage.from || "未知发件人")}</span>
          <span className="mode-mail-route-arrow">→</span>
          <span>{selectedMessage.recipientAddress || selectedMessage.address}</span>
        </div>

        <div className="mode-mail-body mode-mail-body-reader">
          <div className="mode-mail-content-head">
            <span>邮件内容</span>
            {selectedHasHtmlContent ? (
              <div className="mail-view-switch" role="tablist" aria-label="邮件视图切换">
                <button
                  type="button"
                  className={`mail-view-switch-button ${selectedViewMode === "html" ? "is-active" : ""}`}
                  onClick={() =>
                    setMessageViewModes((current) => ({
                      ...current,
                      [selectedMessage.id]: "html"
                    }))
                  }
                  aria-pressed={selectedViewMode === "html"}
                >
                  HTML
                </button>
                <button
                  type="button"
                  className={`mail-view-switch-button ${selectedViewMode === "text" ? "is-active" : ""}`}
                  onClick={() =>
                    setMessageViewModes((current) => ({
                      ...current,
                      [selectedMessage.id]: "text"
                    }))
                  }
                  aria-pressed={selectedViewMode === "text"}
                >
                  纯文本
                </button>
              </div>
            ) : null}
          </div>
          {selectedViewMode === "html" && selectedMessage.htmlContent ? (
            <EmailHtmlFrame
              html={selectedMessage.htmlContent}
              title={`${selectedMessage.subject || "邮件"} HTML 视图`}
              theme={theme}
              inlineResourceMap={selectedMessage.inlineResourceMap}
              className="mail-html-frame mail-html-frame-reader"
            />
          ) : (
            <pre className="mail-plain-text mail-plain-text-reader">{selectedTextContent}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function OptionsApp() {
  const [profiles, setProfiles] = useState<DuckProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [theme, setTheme] = useState<PopupTheme>("dark");
  const [panelView, setPanelView] = useState<PanelView>("edit");
  const [tempMailStatusScope, setTempMailStatusScope] = useState<MailScope>("current");
  const [hasMoreStatusMessages, setHasMoreStatusMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [adminLoadedCount, setAdminLoadedCount] = useState(0);
  const adminTotalCountRef = useRef(0);
  const [deleteTargetProfileId, setDeleteTargetProfileId] = useState<string | null>(null);

  useEffect(() => {
    async function hydrate() {
      const [storedProfiles, activeProfileId, storedTheme] = await Promise.all([
        loadProfiles(),
        loadActiveProfileId(),
        loadPopupTheme()
      ]);

      const fallbackProfiles = storedProfiles.length
        ? storedProfiles
        : [createEmptyProfile("默认 Duck")];
      const nextSelectedId =
        activeProfileId && fallbackProfiles.some((item) => item.id === activeProfileId)
          ? activeProfileId
          : fallbackProfiles[0].id;

      setProfiles(fallbackProfiles);
      setSelectedProfileId(nextSelectedId);
      setTheme(storedTheme);

      if (!storedProfiles.length) {
        await saveProfiles(fallbackProfiles);
      }

      await saveActiveProfileId(nextSelectedId);
      setLoading(false);
    }

    void hydrate();
  }, []);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timeout = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!deleteTargetProfileId) {
      return undefined;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDeleteTargetProfileId(null);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [deleteTargetProfileId]);

  const selectedProfile = getSelectedProfile(profiles, selectedProfileId);
  const tempMailHistoryOptions = useMemo(
    () => (selectedProfile ? getTempMailHistoryOptions(selectedProfile) : []),
    [selectedProfile]
  );
  const canViewAllTempMailHistory = Boolean(
    selectedProfile?.mode === "tempmail" && selectedProfile.tempMail.adminAuth.trim()
  );
  const statusScopeData = useMemo(
    () => (selectedProfile ? getStatusMailScopeData(selectedProfile, tempMailStatusScope) : null),
    [selectedProfile, tempMailStatusScope]
  );

  const stats = useMemo(() => {
    if (!selectedProfile || !statusScopeData) {
      return {
        total: 0,
        loadedLabel: "0",
        unread: 0,
        currentAddress: "未选择配置"
      };
    }

    const isAllScope = selectedProfile.mode === "tempmail" && tempMailStatusScope === "all";
    const total = isAllScope && adminTotalCountRef.current > 0
      ? adminTotalCountRef.current
      : statusScopeData.totalCount > 0
        ? statusScopeData.totalCount
        : statusScopeData.loadedCount;

    return {
      total,
      loadedLabel:
        total > 0 && total !== statusScopeData.loadedCount
          ? `${statusScopeData.loadedCount} / ${total}`
          : String(statusScopeData.loadedCount),
      unread: statusScopeData.unreadCount,
      currentAddress: getProfileAddress(selectedProfile)
    };
  }, [selectedProfile, statusScopeData, tempMailStatusScope]);

  function updateSelectedProfile(updater: (profile: DuckProfile) => DuckProfile) {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === selectedProfileId ? updater(profile) : profile
      )
    );
  }

  async function persistProfiles(nextProfiles: DuckProfile[], nextSelectedId: string) {
    setProfiles(nextProfiles);
    setSelectedProfileId(nextSelectedId);
    await saveProfiles(nextProfiles);
    await saveActiveProfileId(nextSelectedId);
  }

  async function handleSelectStatusMessage(messageId: string) {
    if (!selectedProfile) {
      return;
    }

    if (selectedProfile.mode === "tempmail") {
      if (tempMailStatusScope === "all") {
        const [inboxKey, originalMessageId] = messageId.split("::");
        if (!inboxKey || !originalMessageId) {
          return;
        }

        const nextProfiles = profiles.map((profile) => {
          if (profile.id !== selectedProfile.id) {
            return profile;
          }

          const nextStates = profile.tempMailInboxStates.map((state) =>
            (state.inbox.addressJwt || state.inbox.address) === inboxKey &&
            !state.readMessageIds.includes(originalMessageId)
              ? {
                  ...state,
                  readMessageIds: mergeReadMessageIds(state.readMessageIds, [originalMessageId])
                }
              : state
          );

          return updateProfileTimestamp({
            ...profile,
            tempMailInboxStates: nextStates
          });
        });

        setProfiles(nextProfiles);
        await saveProfiles(nextProfiles);
        return;
      }

      if (selectedProfile.readMessageIds.includes(messageId)) {
        return;
      }

      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? syncCurrentTempMailInboxState(profile, (state) => ({
              ...state,
              readMessageIds: mergeReadMessageIds(state.readMessageIds, [messageId])
            }))
          : profile
      );

      setProfiles(nextProfiles);
      await saveProfiles(nextProfiles);
      return;
    }

    if (selectedProfile.readMessageIds.includes(messageId)) {
      return;
    }

    const nextProfiles = profiles.map((profile) =>
      profile.id === selectedProfile.id
        ? updateProfileTimestamp({
            ...profile,
            readMessageIds: mergeReadMessageIds(profile.readMessageIds, [messageId])
          })
        : profile
    );

    setProfiles(nextProfiles);
    await saveProfiles(nextProfiles);
  }

  async function handleToggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    await savePopupTheme(nextTheme);
  }

  async function handleSelectProfile(profileId: string) {
    setSelectedProfileId(profileId);
    setPanelView("edit");
    await saveActiveProfileId(profileId);
  }

  async function handleCreateProfile() {
    const profile = createEmptyProfile(`配置 ${profiles.length + 1}`);
    const nextProfiles = [profile, ...profiles];
    await persistProfiles(nextProfiles, profile.id);
    setPanelView("edit");
    setNotice({ type: "success", message: "已新增一个配置。" });
  }

  async function handleDeleteProfile() {
    if (!selectedProfile) {
      return;
    }

    setBusyAction("delete");

    try {
      const remainingProfiles = profiles.filter((profile) => profile.id !== selectedProfile.id);
      const fallbackProfile =
        remainingProfiles[0] || createEmptyProfile("默认 Duck");
      const nextProfiles = remainingProfiles.length ? remainingProfiles : [fallbackProfile];
      const nextSelectedId = nextProfiles[0].id;

      await persistProfiles(nextProfiles, nextSelectedId);
      setPanelView("edit");
      setDeleteTargetProfileId(null);
      setNotice({
        type: "success",
        message:
          remainingProfiles.length > 0
            ? "当前配置已删除。"
            : "当前配置已删除，已自动补一个默认配置。"
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "删除配置失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveProfile() {
    if (!selectedProfile) {
      return;
    }

    if (!selectedProfile.name.trim()) {
      setNotice({ type: "error", message: "请先填写名称。" });
      return;
    }

    if (selectedProfile.mode === "duck" && !selectedProfile.duck.token.trim()) {
      setNotice({ type: "error", message: "Duck 模式下请先填写 Duck token。" });
      return;
    }

    if (selectedProfile.mode === "tempmail" && !selectedProfile.tempMail.baseUrl.trim()) {
      setNotice({ type: "error", message: "请先填写 Temp Mail Base URL。" });
      return;
    }

    if (selectedProfile.mode === "tempmail" && !selectedProfile.tempMail.domain.trim()) {
      setNotice({ type: "error", message: "请先填写 Temp Mail Domain。" });
      return;
    }

    setBusyAction("save");

    try {
      const nextProfiles = profiles.map((profile) => {
        if (profile.id !== selectedProfile.id) {
          return profile;
        }

        const normalizedProfile = patchDuckProfileTempMailFromInbox(selectedProfile);

        return updateProfileTimestamp({
          ...normalizedProfile,
          name: selectedProfile.name.trim(),
          duck: {
            ...normalizedProfile.duck,
            apiBaseUrl: normalizeUrl(normalizedProfile.duck.apiBaseUrl),
            token: normalizedProfile.duck.token.trim(),
            aliasDomain: normalizedProfile.duck.aliasDomain.trim()
          },
          tempMail: {
            ...normalizedProfile.tempMail,
            baseUrl: normalizeUrl(normalizedProfile.tempMail.baseUrl),
            adminAuth: normalizedProfile.tempMail.adminAuth.trim(),
            customAuth: normalizedProfile.tempMail.customAuth.trim(),
            domain: normalizedProfile.tempMail.domain.trim(),
            namePrefix: normalizedProfile.tempMail.namePrefix.trim(),
            pollIntervalMs: parseNumber(
              String(normalizedProfile.tempMail.pollIntervalMs),
              normalizedProfile.tempMail.pollIntervalMs
            ),
            pollTimeoutMs: parseNumber(
              String(normalizedProfile.tempMail.pollTimeoutMs),
              normalizedProfile.tempMail.pollTimeoutMs
            )
          },
          inbox:
            normalizedProfile.inbox &&
            (normalizedProfile.inbox.address.trim() || normalizedProfile.inbox.addressJwt.trim())
              ? {
                  ...normalizedProfile.inbox,
                  address: normalizedProfile.inbox.address.trim(),
                  addressJwt: normalizedProfile.inbox.addressJwt.trim()
                }
              : null
        });
      });

      await persistProfiles(nextProfiles, selectedProfile.id);
      setNotice({ type: "success", message: "当前配置已保存。" });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "保存配置失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleGenerateAlias() {
    if (!selectedProfile) {
      return;
    }

    if (!selectedProfile.duck.token.trim()) {
      setNotice({ type: "error", message: "请先填写并保存 Duck token。" });
      return;
    }

    setBusyAction("alias");

    try {
      const alias = await createDuckAlias(selectedProfile.duck);
      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id ? mergeAlias(profile, alias) : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setNotice({ type: "success", message: `已生成地址：${alias.address}` });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "生成 Duck 地址失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateInbox() {
    if (!selectedProfile) {
      return;
    }

    if (!selectedProfile.tempMail.baseUrl.trim() || !selectedProfile.tempMail.domain.trim()) {
      setNotice({ type: "error", message: "请先填写 Temp Mail Base URL 和 Domain。" });
      return;
    }

    if (!selectedProfile.tempMail.adminAuth.trim()) {
      setNotice({ type: "error", message: "创建收件箱前请先填写 Admin Auth。" });
      return;
    }

    setBusyAction("inbox");

    try {
      const inbox = await createTempMailInbox(selectedProfile.tempMail);
      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? applyTempMailInbox(profile, inbox)
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setNotice({ type: "success", message: `已创建收件箱：${inbox.address}，请重新同步这一个邮箱的邮件。` });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "创建 Temp 收件箱失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSelectTempMailInbox(inbox: TempMailInbox) {
    if (!selectedProfile || sameTempMailInbox(selectedProfile.inbox, inbox)) {
      setTempMailStatusScope("current");
      return;
    }

    const appliedProfile = applyTempMailInbox(selectedProfile, inbox);
    const nextProfiles = profiles.map((profile) =>
      profile.id === selectedProfile.id ? appliedProfile : profile
    );

    await persistProfiles(nextProfiles, selectedProfile.id);
    setTempMailStatusScope("current");

    // Auto-sync messages for the switched inbox
    if (!inbox.addressJwt?.trim()) {
      setNotice({ type: "info", message: `已切换到 ${inbox.address}。` });
      return;
    }

    const normalizedProfile = patchDuckProfileTempMailFromInbox(appliedProfile);
    if (!normalizedProfile.tempMail.baseUrl.trim()) {
      setNotice({ type: "info", message: `已切换到 ${inbox.address}。` });
      return;
    }

    setBusyAction("sync");

    try {
      const { messages, totalCount } = await fetchTempMailMessageSummaryPage(
        {
          ...normalizedProfile.tempMail,
          ...inbox
        },
        {
          limit: MESSAGE_PAGE_SIZE,
          offset: 0
        }
      );

      const syncedProfiles = nextProfiles.map((profile) =>
        profile.id === selectedProfile.id
          ? syncCurrentTempMailInboxState(
              appliedProfile,
              (state) => ({
                ...state,
                inbox,
                messages,
                messageTotal: totalCount ?? messages.length,
                readMessageIds: mergeReadMessageIds(state.readMessageIds),
                lastSyncedAt: new Date().toISOString()
              })
            )
          : profile
      );

      await persistProfiles(syncedProfiles, selectedProfile.id);
      const resolvedTotal = totalCount ?? messages.length;
      setHasMoreStatusMessages(getHasMoreMessages(resolvedTotal, messages.length, messages.length));
      setNotice({
        type: "success",
        message: `已切换到 ${inbox.address}，同步 ${messages.length} 封邮件${resolvedTotal > messages.length ? `（共 ${resolvedTotal}）` : ""}。`
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: `已切换到 ${inbox.address}，但同步失败：${error instanceof Error ? error.message : "未知错误"}`
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSyncMessages() {
    if (!selectedProfile || !selectedProfile.inbox?.addressJwt.trim()) {
      if (!(selectedProfile?.mode === "tempmail" && tempMailStatusScope === "all" && tempMailHistoryOptions.length)) {
        setNotice({ type: "error", message: "请先创建或填写收件箱信息。" });
        return;
      }
    }

    const normalizedProfile = patchDuckProfileTempMailFromInbox(selectedProfile);

    if (!normalizedProfile.tempMail.baseUrl.trim()) {
      setNotice({ type: "error", message: "无法识别 Temp Mail 地址对应的接口地址，请补充完整收件信息。" });
      return;
    }

    const inbox = normalizedProfile.inbox;
    if (!inbox?.addressJwt.trim()) {
      setNotice({ type: "error", message: "请先填写有效的 Temp Mail JWT。" });
      return;
    }

    setBusyAction("sync");

    try {
      if (selectedProfile.mode === "tempmail" && tempMailStatusScope === "all") {
        const { messages, totalCount } = await fetchTempMailAdminMessageSummaryPage(
          normalizedProfile.tempMail,
          "",
          {
            limit: MESSAGE_PAGE_SIZE,
            offset: 0
          }
        );

        const existingStateMap = new Map(
          selectedProfile.tempMailInboxStates.map((state) => [state.inbox.address, state])
        );
        const groupedMessages = new Map<string, MailSummary[]>();

        for (const message of messages) {
          const mailboxAddress = message.recipientAddress || message.address;
          if (!mailboxAddress) {
            continue;
          }

          const currentMessages = groupedMessages.get(mailboxAddress) || [];
          currentMessages.push(message);
          groupedMessages.set(mailboxAddress, currentMessages);
        }

        // Build states for known inboxes + any new addresses discovered from admin
        const processedAddresses = new Set<string>();
        const nextStates: TempMailInboxState[] = [];

        for (const { inbox } of tempMailHistoryOptions) {
          const currentState = existingStateMap.get(inbox.address) || buildTempMailInboxState(inbox);
          const nextMessages = groupedMessages.get(inbox.address) || [];
          processedAddresses.add(inbox.address);

          nextStates.push({
            ...currentState,
            inbox,
            messages: nextMessages,
            messageTotal: nextMessages.length,
            readMessageIds: mergeReadMessageIds(currentState.readMessageIds),
            lastSyncedAt: new Date().toISOString()
          });
        }

        // Create states for addresses found in admin results but not in history
        for (const [address, addressMessages] of groupedMessages) {
          if (processedAddresses.has(address)) {
            continue;
          }

          const discoveredInbox: TempMailInbox = {
            address,
            addressJwt: "",
            createdAt: new Date().toISOString()
          };
          const existingState = existingStateMap.get(address);

          nextStates.push({
            inbox: discoveredInbox,
            messages: addressMessages,
            messageTotal: addressMessages.length,
            readMessageIds: mergeReadMessageIds(existingState?.readMessageIds || []),
            lastSyncedAt: new Date().toISOString()
          });
        }

        const currentInboxState =
          (selectedProfile.inbox &&
            nextStates.find((state) => sameTempMailInbox(state.inbox, selectedProfile.inbox))) ||
          null;

        // Merge discovered inboxes into tempMailInboxes so they appear in the dropdown
        let mergedInboxes = [...selectedProfile.tempMailInboxes];
        for (const state of nextStates) {
          if (!mergedInboxes.some((inbox) => sameTempMailInbox(inbox, state.inbox))) {
            mergedInboxes.push(state.inbox);
          }
        }

        const nextProfiles = profiles.map((profile) =>
          profile.id === selectedProfile.id
            ? updateProfileTimestamp({
                ...profile,
                tempMail: normalizedProfile.tempMail,
                tempMailInboxes: mergedInboxes,
                tempMailInboxStates: nextStates,
                messages: currentInboxState?.messages || profile.messages,
                messageTotal: currentInboxState?.messageTotal ?? profile.messageTotal,
                readMessageIds: currentInboxState?.readMessageIds || profile.readMessageIds,
                lastSyncedAt: currentInboxState?.lastSyncedAt || profile.lastSyncedAt
              })
            : profile
        );

        await persistProfiles(nextProfiles, selectedProfile.id);
        const resolvedAdminTotal = totalCount ?? messages.length;
        setAdminLoadedCount(messages.length);
        adminTotalCountRef.current = resolvedAdminTotal;
        setHasMoreStatusMessages(getHasMoreMessages(resolvedAdminTotal, messages.length, messages.length));
        setNotice({
          type: "success",
          message: `已通过 admin 同步全部历史邮箱，当前加载 ${messages.length}${resolvedAdminTotal > messages.length ? ` / ${resolvedAdminTotal}` : ""} 封邮件。`
        });
        return;
      }

      const { messages, totalCount } = await fetchTempMailMessageSummaryPage(
        {
          ...normalizedProfile.tempMail,
          ...inbox
        },
        {
          limit: MESSAGE_PAGE_SIZE,
          offset: 0
        }
      );

      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? syncCurrentTempMailInboxState(
              {
                ...profile,
                tempMail: normalizedProfile.tempMail
              },
              (state) => ({
                ...state,
                inbox,
                messages,
                messageTotal: totalCount ?? messages.length,
                readMessageIds: mergeReadMessageIds(state.readMessageIds),
                lastSyncedAt: new Date().toISOString()
              })
            )
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      const resolvedTotal = totalCount ?? messages.length;
      setHasMoreStatusMessages(getHasMoreMessages(resolvedTotal, messages.length, messages.length));
      setNotice({
        type: "success",
        message: messages.length
          ? `已同步 ${messages.length} 封邮件，当前已加载 ${messages.length}${resolvedTotal > messages.length ? ` / ${resolvedTotal}` : ""}。`
          : "当前没有同步到邮件。"
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "同步邮件失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLoadMoreMessages() {
    if (!selectedProfile || loadingMoreMessages) {
      return;
    }

    const normalizedProfile = patchDuckProfileTempMailFromInbox(selectedProfile);

    // Admin "all" scope load more
    if (selectedProfile.mode === "tempmail" && tempMailStatusScope === "all") {
      if (!normalizedProfile.tempMail.adminAuth.trim()) {
        return;
      }

      setLoadingMoreMessages(true);

      try {
        const { messages: nextPageMessages, totalCount } = await fetchTempMailAdminMessageSummaryPage(
          normalizedProfile.tempMail,
          "",
          {
            limit: MESSAGE_PAGE_SIZE,
            offset: adminLoadedCount
          }
        );

        const existingStateMap = new Map(
          selectedProfile.tempMailInboxStates.map((state) => [state.inbox.address, state])
        );

        // Group new messages by address and merge into existing states
        const groupedNewMessages = new Map<string, MailSummary[]>();
        for (const message of nextPageMessages) {
          const mailboxAddress = message.recipientAddress || message.address;
          if (!mailboxAddress) {
            continue;
          }
          const currentMessages = groupedNewMessages.get(mailboxAddress) || [];
          currentMessages.push(message);
          groupedNewMessages.set(mailboxAddress, currentMessages);
        }

        const processedAddresses = new Set<string>();
        const nextStates: TempMailInboxState[] = [];

        // Update existing states with merged messages
        for (const state of selectedProfile.tempMailInboxStates) {
          const newMessages = groupedNewMessages.get(state.inbox.address) || [];
          const mergedMessages = mergeMailSummaries(state.messages, newMessages);
          processedAddresses.add(state.inbox.address);

          nextStates.push({
            ...state,
            messages: mergedMessages,
            messageTotal: mergedMessages.length,
            lastSyncedAt: new Date().toISOString()
          });
        }

        // Create states for newly discovered addresses
        for (const [address, addressMessages] of groupedNewMessages) {
          if (processedAddresses.has(address)) {
            continue;
          }

          nextStates.push({
            inbox: { address, addressJwt: "", createdAt: new Date().toISOString() },
            messages: addressMessages,
            messageTotal: addressMessages.length,
            readMessageIds: [],
            lastSyncedAt: new Date().toISOString()
          });
        }

        let mergedInboxes = [...selectedProfile.tempMailInboxes];
        for (const state of nextStates) {
          if (!mergedInboxes.some((inbox) => sameTempMailInbox(inbox, state.inbox))) {
            mergedInboxes.push(state.inbox);
          }
        }

        const currentInboxState =
          (selectedProfile.inbox &&
            nextStates.find((state) => sameTempMailInbox(state.inbox, selectedProfile.inbox))) ||
          null;

        const nextProfiles = profiles.map((profile) =>
          profile.id === selectedProfile.id
            ? updateProfileTimestamp({
                ...profile,
                tempMail: normalizedProfile.tempMail,
                tempMailInboxes: mergedInboxes,
                tempMailInboxStates: nextStates,
                messages: currentInboxState?.messages || profile.messages,
                messageTotal: currentInboxState?.messageTotal ?? profile.messageTotal,
                readMessageIds: currentInboxState?.readMessageIds || profile.readMessageIds,
                lastSyncedAt: currentInboxState?.lastSyncedAt || profile.lastSyncedAt
              })
            : profile
        );

        const nextAdminLoaded = adminLoadedCount + nextPageMessages.length;
        await persistProfiles(nextProfiles, selectedProfile.id);
        setAdminLoadedCount(nextAdminLoaded);
        if (totalCount != null) {
          adminTotalCountRef.current = totalCount;
        }
        const resolvedTotal = totalCount ?? adminTotalCountRef.current ?? nextAdminLoaded;
        setHasMoreStatusMessages(
          getHasMoreMessages(resolvedTotal, nextAdminLoaded, nextPageMessages.length)
        );
      } catch {
        // silent
      } finally {
        setLoadingMoreMessages(false);
      }
      return;
    }

    // Current inbox load more
    if (!selectedProfile.inbox?.addressJwt.trim()) {
      return;
    }

    const inbox = normalizedProfile.inbox;
    if (!inbox?.addressJwt.trim()) {
      return;
    }

    setLoadingMoreMessages(true);

    try {
      const { messages: nextPageMessages, totalCount } = await fetchTempMailMessageSummaryPage(
        {
          ...normalizedProfile.tempMail,
          ...inbox
        },
        {
          limit: MESSAGE_PAGE_SIZE,
          offset: selectedProfile.messages.length
        }
      );

      const mergedMessages = mergeMailSummaries(selectedProfile.messages, nextPageMessages);

      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? syncCurrentTempMailInboxState(
              {
                ...profile,
                tempMail: normalizedProfile.tempMail
              },
              (state) => ({
                ...state,
                inbox,
                messages: mergedMessages,
                messageTotal: totalCount ?? Math.max(state.messageTotal, mergedMessages.length),
                readMessageIds: mergeReadMessageIds(state.readMessageIds),
                lastSyncedAt: new Date().toISOString()
              })
            )
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      const resolvedTotal = totalCount ?? Math.max(selectedProfile.messageTotal, mergedMessages.length);
      setHasMoreStatusMessages(
        getHasMoreMessages(resolvedTotal, mergedMessages.length, nextPageMessages.length)
      );
    } catch {
      // silent
    } finally {
      setLoadingMoreMessages(false);
    }
  }

  useEffect(() => {
    if (selectedProfile?.mode !== "tempmail") {
      setTempMailStatusScope("current");
    }
  }, [selectedProfile?.id, selectedProfile?.mode]);

  useEffect(() => {
    if (!canViewAllTempMailHistory && tempMailStatusScope === "all") {
      setTempMailStatusScope("current");
    }
  }, [canViewAllTempMailHistory, tempMailStatusScope]);

  useEffect(() => {
    if (!selectedProfile) {
      setHasMoreStatusMessages(false);
      return;
    }

    if (selectedProfile.mode === "tempmail" && tempMailStatusScope === "all") {
      // Admin "all" scope hasMore is managed by handleSyncMessages/handleLoadMoreMessages
      return;
    }

    setHasMoreStatusMessages(
      getHasMoreMessages(
        selectedProfile.messageTotal,
        selectedProfile.messages.length,
        selectedProfile.messages.length
      )
    );
  }, [selectedProfile, tempMailStatusScope]);

  if (loading || !selectedProfile) {
    return (
      <main className="page-shell">
        <div className="status-banner info">正在加载设置页...</div>
      </main>
    );
  }

  const currentAlias = getActiveAlias(selectedProfile);

  return (
    <main className={`mode-settings-page ${theme === "light" ? "theme-light" : "theme-dark"}`}>
      <div className="mode-settings-layout">
        <aside className="mode-shell mode-sidebar">
          <div className="mode-top-row">
            <div className="mode-brand">
              <span className="mode-eyebrow">Duck Mailbox</span>
              <strong>配置列表</strong>
            </div>
            <button className="mode-ghost-btn" onClick={() => void handleCreateProfile()}>
              新增
            </button>
          </div>

          <div className="mode-view-switch">
            <button
              type="button"
              className={`mode-view-btn ${panelView === "edit" ? "is-active" : ""}`}
              onClick={() => setPanelView("edit")}
            >
              编辑配置
            </button>
            <button
              type="button"
              className={`mode-view-btn ${panelView === "status" ? "is-active" : ""}`}
              onClick={() => setPanelView("status")}
            >
              状态信息
            </button>
          </div>

          <div className="mode-profile-list">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`mode-profile-item ${profile.id === selectedProfile.id ? "is-active" : ""}`}
                onClick={() => void handleSelectProfile(profile.id)}
              >
                <strong>{profile.name}</strong>
                <span>{getModeLabel(profile.mode)}</span>
                <em>{getProfileSummaryLine(profile)}</em>
              </button>
            ))}
          </div>
        </aside>

        <section className="mode-shell mode-main">
          <div className="mode-toolbar">
            <div className="mode-brand">
              <span className="mode-eyebrow">Mode Based Settings</span>
              <strong>{panelView === "edit" ? "配置编辑" : "状态信息"}</strong>
              <p>
                {panelView === "edit"
                  ? "默认进入配置编辑，只处理参数本身。"
                  : "把当前配置的运行状态、同步结果和邮件内容集中查看。"}
              </p>
            </div>

            <div className="mode-toolbar-actions">
              <div className="mode-theme-pill">主题跟随 popup</div>
              <button className="mode-icon-btn" onClick={() => void handleToggleTheme()} title="切换主题">
                ◐
              </button>
            </div>
          </div>

          {notice ? <div className={`mode-notice ${notice.type}`}>{notice.message}</div> : null}

          {panelView === "edit" ? (
            <>
              <section className="mode-shell-inner mode-summary">
                <div className="mode-top-row">
                  <div>
                    <div className="mode-summary-title">编辑配置</div>
                    <div className="mode-summary-desc">当前配置默认只展示编辑项，不显示状态卡片和邮件列表。</div>
                  </div>
                  <div className="mode-action-row">
                    <button
                      className="mode-danger-btn"
                      disabled={busyAction !== null}
                      onClick={() => setDeleteTargetProfileId(selectedProfile.id)}
                    >
                      {busyAction === "delete" ? "删除中..." : "删除当前配置"}
                    </button>
                    <button className="mode-secondary-btn" onClick={() => void handleSaveProfile()}>
                      {busyAction === "save" ? "保存中..." : "保存当前配置"}
                    </button>
                  </div>
                </div>

                <div className="mode-summary-inline">
                  <span>当前名称：{selectedProfile.name || "未命名"}</span>
                  <span>当前模式：{getModeLabel(selectedProfile.mode)}</span>
                </div>
              </section>

              <section className="mode-shell-inner mode-section">
                <div className="mode-section-head">
                  <div>
                    <div className="mode-section-title">接入方式</div>
                    <div className="mode-section-desc">先选模式，再显示这套模式真正需要配置的内容。</div>
                  </div>
                </div>

                <div className="mode-card-grid">
                  <button
                    type="button"
                    className={`mode-select-card ${selectedProfile.mode === "duck" ? "is-active" : ""}`}
                    onClick={() =>
                      updateSelectedProfile((profile) =>
                        updateProfileTimestamp({
                          ...profile,
                          mode: "duck"
                        })
                      )
                    }
                  >
                    <strong>1. DuckDuckGo 转发</strong>
                    <p>Duck 负责生成别名，Temp Mail 负责查看转发后的邮件。</p>
                    <span>Duck token + Temp Mail 收件箱</span>
                  </button>

                  <button
                    type="button"
                    className={`mode-select-card ${selectedProfile.mode === "tempmail" ? "is-active" : ""}`}
                    onClick={() =>
                      updateSelectedProfile((profile) =>
                        updateProfileTimestamp({
                          ...profile,
                          mode: "tempmail"
                        })
                      )
                    }
                  >
                    <strong>2. Temp Mail 直连</strong>
                    <p>直接按 Temp Mail 协议配置，点击创建收件箱后自动拿到地址和 JWT。</p>
                    <span>Base URL + Admin Auth + Domain</span>
                  </button>
                </div>
              </section>

              {selectedProfile.mode === "duck" ? (
                <section className="mode-shell-inner mode-section">
                  <div className="mode-section-head">
                    <div>
                      <div className="mode-section-title">DuckDuckGo 转发配置</div>
                      <div className="mode-section-desc">
                        Duck 只负责生成别名；Temp Mail 在这里仅作为“查看转发邮件”的收件箱。
                      </div>
                    </div>
                  </div>

                  <div className="mode-field-grid">
                    <label className="mode-field span-4">
                      <span>名称</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.name}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            name: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>Duck Alias Domain</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.duck.aliasDomain}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            duck: {
                              ...profile.duck,
                              aliasDomain: event.target.value
                            }
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>Duck API Base URL</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.duck.apiBaseUrl}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            duck: {
                              ...profile.duck,
                              apiBaseUrl: event.target.value
                            }
                          }))
                        }
                      />
                    </label>

                    <label className="mode-field span-12">
                      <span>Duck Token</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.duck.token}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            duck: {
                              ...profile.duck,
                              token: event.target.value
                            }
                          }))
                        }
                      />
                    </label>

                    <label className="mode-field span-6">
                      <span>Temp Mail Address</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.inbox?.address || ""}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            inbox: buildInboxPatch(profile.inbox, {
                              address: event.target.value
                            })
                          }))
                        }
                        placeholder="duckduckgo@example.com"
                      />
                    </label>
                    <label className="mode-field span-6">
                      <span>Temp Mail JWT</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.inbox?.addressJwt || ""}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            inbox: buildInboxPatch(profile.inbox, {
                              addressJwt: event.target.value
                            })
                          }))
                        }
                        placeholder="eyJhbGciOi..."
                      />
                    </label>
                  </div>
                </section>
              ) : (
                <section className="mode-shell-inner mode-section">
                  <div className="mode-section-head">
                    <div>
                      <div className="mode-section-title">Temp Mail 直连配置</div>
                      <div className="mode-section-desc">
                        这里不需要预先手填收件地址和 JWT，点击创建收件箱后会自动回填。
                      </div>
                    </div>
                  </div>

                  <div className="mode-field-grid">
                    <label className="mode-field span-4">
                      <span>名称</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.name}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            name: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>Base URL</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.tempMail.baseUrl}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              baseUrl: event.target.value
                            }
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>Domain</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.tempMail.domain}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              domain: event.target.value
                            }
                          }))
                        }
                      />
                    </label>

                    <label className="mode-field span-8">
                      <span>Admin Auth</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.tempMail.adminAuth}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              adminAuth: event.target.value
                            }
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>Name Prefix</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.tempMail.namePrefix}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              namePrefix: event.target.value
                            }
                          }))
                        }
                      />
                    </label>

                    <label className="mode-field span-4">
                      <span>轮询间隔</span>
                      <input
                        className="mode-input"
                        type="number"
                        value={selectedProfile.tempMail.pollIntervalMs}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              pollIntervalMs: parseNumber(
                                event.target.value,
                                profile.tempMail.pollIntervalMs
                              )
                            }
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>超时</span>
                      <input
                        className="mode-input"
                        type="number"
                        value={selectedProfile.tempMail.pollTimeoutMs}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              pollTimeoutMs: parseNumber(
                                event.target.value,
                                profile.tempMail.pollTimeoutMs
                              )
                            }
                          }))
                        }
                      />
                    </label>
                    <label className="mode-field span-4">
                      <span>Custom Auth</span>
                      <input
                        className="mode-input"
                        value={selectedProfile.tempMail.customAuth}
                        onChange={(event) =>
                          updateSelectedProfile((profile) => ({
                            ...profile,
                            tempMail: {
                              ...profile.tempMail,
                              customAuth: event.target.value
                            }
                          }))
                        }
                        placeholder="可选"
                      />
                    </label>
                  </div>

                </section>
              )}
            </>
          ) : (
            <>
              <section className="mode-shell-inner mode-summary">
                <div>
                  <div className="mode-summary-title">当前状态</div>
                  <div className="mode-summary-desc">
                    把有用的状态压成一块：当前配置、同步时间、转发链路和操作按钮，不再重复展示相同信息。
                  </div>
                </div>

                <div className="mode-status-inline">
                  <span className="mode-status-pill">
                    配置
                    <strong>{selectedProfile.name || "未命名"}</strong>
                  </span>
                  <span className="mode-status-pill">
                    模式
                    <strong>{getModeLabel(selectedProfile.mode)}</strong>
                  </span>
                  <span className="mode-status-pill">
                    最近同步
                    <strong>{formatAbsoluteDateTime(statusScopeData?.lastSyncedAt || selectedProfile.lastSyncedAt)}</strong>
                  </span>
                </div>

                <div className="mode-route-card">
                  <div className="mode-route-head">
                    <div className="mode-route-top">
                      <span className="mode-route-chip">
                        {selectedProfile.mode === "duck" ? "当前 Duck 地址" : "当前模式"}
                      </span>
                      <span className="mode-route-chip">当前收件箱</span>
                    </div>

                    <div className="mode-route-actions">
                      {selectedProfile.mode === "duck" ? (
                        <button
                          className="mode-ghost-btn mode-route-action-btn"
                          disabled={busyAction !== null}
                          onClick={() => void handleGenerateAlias()}
                        >
                          {busyAction === "alias" ? "生成中..." : "生成 Duck 地址"}
                        </button>
                      ) : (
                        <button
                          className="mode-ghost-btn mode-route-action-btn"
                          disabled={busyAction !== null}
                          onClick={() => void handleCreateInbox()}
                        >
                          {busyAction === "inbox" ? "创建中..." : "创建收件箱"}
                        </button>
                      )}
                      <button
                        className="mode-secondary-btn mode-route-action-btn"
                        disabled={busyAction !== null}
                        onClick={() => void handleSyncMessages()}
                      >
                        {busyAction === "sync" ? "同步中..." : "立即同步"}
                      </button>
                    </div>
                  </div>

                  <div className="mode-route-line">
                    <code>
                      {selectedProfile.mode === "duck"
                        ? currentAlias?.address || "还没有生成 Duck 地址"
                        : "Temp Mail 直连"}
                    </code>
                    <span>→</span>
                    <code>{selectedProfile.inbox?.address || "尚未创建收件箱"}</code>
                  </div>

                  <div className="mode-route-note">
                    {selectedProfile.mode === "duck"
                      ? "当前这套配置会把 Duck 收到的邮件转发到右侧收件箱，再由插件同步展示。"
                      : "当前模式会直接从右侧收件箱同步邮件，状态页只展示最终同步结果。"}
                  </div>
                </div>
              </section>

              <section className="mode-shell-inner mode-section">
                <div className="mode-section-head">
                  <div>
                    <div className="mode-section-title">邮件列表</div>
                    <div className="mode-section-desc">状态页里可以直接查看当前配置同步到的邮件内容。</div>
                  </div>
                  {selectedProfile.mode === "tempmail" ? (
                    <div className="mode-status-mailbox-switch">
                      <span>切换邮箱</span>
                      <select
                        value={
                          tempMailStatusScope === "all"
                            ? "all"
                            : selectedProfile.inbox?.addressJwt || selectedProfile.inbox?.address || ""
                        }
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          if (nextValue === "all") {
                            setTempMailStatusScope("all");
                            setAdminLoadedCount(0);
                            adminTotalCountRef.current = 0;
                            setHasMoreStatusMessages(false);
                            return;
                          }

                          const nextInbox = tempMailHistoryOptions.find(({ value }) => value === nextValue)?.inbox;
                          if (!nextInbox) {
                            return;
                          }

                          void handleSelectTempMailInbox(nextInbox);
                        }}
                      >
                        {canViewAllTempMailHistory ? (
                          <option value="all">全部邮箱（仅查看）</option>
                        ) : null}
                        {tempMailHistoryOptions.map(({ value, inbox }) => (
                          <option key={value} value={value}>
                            {inbox.address}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>

                <div className="mode-mail-counter">
                  <span className="mode-status-pill">
                    已加载
                    <strong>{stats.loadedLabel}</strong>
                  </span>
                  <span className="mode-status-pill">
                    未读
                    <strong>{stats.unread}</strong>
                  </span>
                </div>

                <StatusMailList
                  messages={statusScopeData?.messages || []}
                  readMessageIds={statusScopeData?.readMessageIds || []}
                  theme={theme}
                  hasMore={hasMoreStatusMessages}
                  loadingMore={loadingMoreMessages}
                  onLoadMore={handleLoadMoreMessages}
                  onSelectMessage={handleSelectStatusMessage}
                  showRecipientAddress={statusScopeData?.showRecipientAddress}
                />
              </section>
            </>
          )}
        </section>
      </div>

      {deleteTargetProfileId === selectedProfile.id ? (
        <div
          className="mode-dialog-backdrop"
          onClick={() => {
            if (busyAction !== "delete") {
              setDeleteTargetProfileId(null);
            }
          }}
        >
          <div
            className="mode-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-profile-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mode-dialog-eyebrow">删除确认</div>
            <h3 id="delete-profile-title" className="mode-dialog-title">
              确定删除当前配置？
            </h3>
            <p className="mode-dialog-text">
              配置 <strong>{selectedProfile.name || "未命名配置"}</strong> 会从本地设置里移除，相关收件箱参数和同步记录也会一起删除。
            </p>
            <div className="mode-dialog-actions">
              <button
                type="button"
                className="mode-ghost-btn"
                disabled={busyAction === "delete"}
                onClick={() => setDeleteTargetProfileId(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="mode-danger-btn"
                disabled={busyAction === "delete"}
                onClick={() => void handleDeleteProfile()}
              >
                {busyAction === "delete" ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
