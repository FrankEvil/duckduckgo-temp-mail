import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { createDuckAlias } from "../features/ddg/client";
import {
  createTempMailInbox
} from "../features/temp-mail/client";
import { fetchCurrentInboxMessageSummaryPage } from "../features/temp-mail/inboxSync";
import {
  EmailHtmlFrame,
  extractMailbox,
  normalizePlainTextContent
} from "../shared/components/EmailHtmlFrame";
import {
  PopupTheme,
  loadActiveProfileId,
  loadPopupTheme,
  loadProfiles,
  saveActiveProfileId,
  savePopupTheme,
  saveProfiles
} from "../shared/storage/local";
import { DuckProfile, TempMailInboxState } from "../shared/types/profile";
import {
  TEMP_MAIL_ANY_DOMAIN,
  TempMailInbox,
  getTempMailConfiguredDomains,
  normalizeTempMailDomainSelection,
  resolveTempMailCreateDomain
} from "../shared/types/tempMail";

type Feedback = {
  type: "success" | "error" | "info";
  message: string;
};

type BusyAction = "generate" | "refresh" | null;

type CopyHint = {
  x: number;
  y: number;
  message: string;
  tone: "success" | "error";
};

type MessageViewMode = "html" | "text";

function getEffectiveAutoRefreshIntervalMs(intervalMs: number) {
  return Math.max(intervalMs, 1);
}

function getFeedbackBadge(type: Feedback["type"]) {
  if (type === "success") {
    return "OK";
  }

  if (type === "error") {
    return "ERR";
  }

  return "TIP";
}

function formatAbsoluteDateTime(value: string) {
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

function getSelectedProfile(profiles: DuckProfile[], selectedProfileId: string | null) {
  return profiles.find((item) => item.id === selectedProfileId) ?? profiles[0] ?? null;
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

    return {
      ...profile,
      messages: fallbackState.messages,
      messageTotal: fallbackState.messageTotal,
      readMessageIds: fallbackState.readMessageIds,
      lastSyncedAt: fallbackState.lastSyncedAt,
      updatedAt: new Date().toISOString()
    };
  }

  const currentState = getCurrentTempMailInboxState(profile) || buildTempMailInboxState(profile.inbox);
  const nextState = updater(currentState);

  return {
    ...profile,
    tempMailInboxes: mergeTempMailInboxes(profile.tempMailInboxes, nextState.inbox),
    tempMailInboxStates: [
      nextState,
      ...profile.tempMailInboxStates.filter((state) => !sameTempMailInbox(state.inbox, profile.inbox))
    ],
    messages: nextState.messages,
    messageTotal: nextState.messageTotal,
    readMessageIds: nextState.readMessageIds,
    lastSyncedAt: nextState.lastSyncedAt,
    updatedAt: new Date().toISOString()
  };
}

export function PopupApp() {
  const frameRef = useRef<HTMLElement | null>(null);
  const [profiles, setProfiles] = useState<DuckProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [copyHint, setCopyHint] = useState<CopyHint | null>(null);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const [messageViewModes, setMessageViewModes] = useState<Record<string, MessageViewMode>>({});
  const [mailboxInputValue, setMailboxInputValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<PopupTheme>("dark");

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timer = window.setTimeout(() => {
      setFeedback(null);
    }, feedback.type === "error" ? 4200 : 2600);

    return () => {
      window.clearTimeout(timer);
    };
  }, [feedback]);

  useEffect(() => {
    if (!copyHint) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopyHint(null);
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copyHint]);

  useEffect(() => {
    async function hydrate() {
      const [storedProfiles, activeProfileId, storedTheme] = await Promise.all([
        loadProfiles(),
        loadActiveProfileId(),
        loadPopupTheme()
      ]);

      const nextSelectedId =
        activeProfileId && storedProfiles.some((item) => item.id === activeProfileId)
          ? activeProfileId
          : storedProfiles[0]?.id || null;

      setProfiles(storedProfiles);
      setSelectedProfileId(nextSelectedId);
      setTheme(storedTheme);
      setExpandedMessageId(null);
      setLoading(false);
    }

    void hydrate();
  }, []);

  useEffect(() => {
    async function refreshProfiles() {
      const [storedProfiles, activeProfileId] = await Promise.all([
        loadProfiles(),
        loadActiveProfileId()
      ]);

      setProfiles(storedProfiles);
      setExpandedMessageId((current) => {
        const allMessages = storedProfiles.flatMap((profile) => profile.messages);
        if (current && allMessages.some((message) => message.id === current)) {
          return current;
        }

        return null;
      });

      if (activeProfileId && storedProfiles.some((item) => item.id === activeProfileId)) {
        setSelectedProfileId(activeProfileId);
        return;
      }

      setSelectedProfileId((current) =>
        current && storedProfiles.some((item) => item.id === current)
          ? current
          : storedProfiles[0]?.id || null
      );
    }

    const listener = () => {
      void refreshProfiles();
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const selectedProfile = getSelectedProfile(profiles, selectedProfileId);
  const currentAlias =
    selectedProfile?.aliases.find((item) => item.id === selectedProfile.currentAliasId) ||
    selectedProfile?.aliases[0] ||
    null;
  const readMessageIds = selectedProfile?.readMessageIds || [];
  const isTempMailMode = selectedProfile?.mode === "tempmail";
  const currentMailboxAddress = isTempMailMode
    ? selectedProfile?.inbox?.address || ""
    : currentAlias?.address || "";
  const currentMailboxPlaceholder = isTempMailMode
    ? "还没有创建 Temp Mail 收件箱"
    : "还没有生成 Duck 邮箱";
  const tempMailHistoryOptions = isTempMailMode
    ? selectedProfile?.tempMailInboxes || (selectedProfile?.inbox ? [selectedProfile.inbox] : [])
    : [];
  const tempMailDomains = selectedProfile ? getTempMailConfiguredDomains(selectedProfile.tempMail) : [];
  const selectedTempMailDomainValue = selectedProfile
    ? normalizeTempMailDomainSelection(selectedProfile.tempMail.domain, tempMailDomains)
    : "";
  const tempMailHistorySelectValue = selectedProfile?.inbox?.addressJwt || selectedProfile?.inbox?.address || "";
  const normalizedCustomMailboxInput = mailboxInputValue.trim().toLowerCase();

  useEffect(() => {
    if (!selectedProfile) {
      setExpandedMessageId(null);
      setMessageViewModes({});
      setMailboxInputValue("");
      return;
    }

    setExpandedMessageId((current) =>
      current && selectedProfile.messages.some((message) => message.id === current)
        ? current
        : null
    );
    setMessageViewModes((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([messageId]) =>
          selectedProfile.messages.some((message) => message.id === messageId)
        )
      )
    );
    setMailboxInputValue("");
  }, [selectedProfile]);

  function getMessageViewMode(messageId: string, hasHtmlContent: boolean): MessageViewMode {
    if (!hasHtmlContent) {
      return "text";
    }

    return messageViewModes[messageId] || "text";
  }

  function handleChangeMessageView(messageId: string, mode: MessageViewMode) {
    setMessageViewModes((current) => ({
      ...current,
      [messageId]: mode
    }));
  }

  async function persistProfiles(nextProfiles: DuckProfile[], nextSelectedId: string) {
    setProfiles(nextProfiles);
    setSelectedProfileId(nextSelectedId);
    await saveProfiles(nextProfiles);
    await saveActiveProfileId(nextSelectedId);
  }

  async function refreshProfileInbox(
    profile: DuckProfile,
    nextSelectedId: string,
    options?: { silent?: boolean }
  ) {
    if (!profile.inbox?.address.trim()) {
      if (!options?.silent) {
        setFeedback({ type: "error", message: "请先创建或填写收件箱信息。" });
      }
      return;
    }

    if (busyAction !== null) {
      return;
    }

    setBusyAction("refresh");

    try {
      const { messages, totalCount } = await fetchCurrentInboxMessageSummaryPage(profile, {
        limit: 20,
        offset: 0
      });

      const nextProfiles = profiles.map((item) =>
        item.id === profile.id
          ? syncCurrentTempMailInboxState(profile, (state) => ({
              ...state,
              inbox: profile.inbox!,
              messages,
              messageTotal: totalCount ?? messages.length,
              readMessageIds: Array.from(new Set(state.readMessageIds)),
              lastSyncedAt: new Date().toISOString()
            }))
          : item
      );

      await persistProfiles(nextProfiles, nextSelectedId);
      setExpandedMessageId(null);

      if (!options?.silent) {
        setFeedback({
          type: "success",
          message: messages.length ? `已同步 ${messages.length} 封邮件` : "当前没有邮件"
        });
      }
    } catch (error) {
      if (!options?.silent) {
        setFeedback({
          type: "error",
          message: error instanceof Error ? error.message : "刷新邮件失败。"
        });
      } else {
        console.warn("Popup auto refresh failed.", error);
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSelectProfile(nextProfileId: string) {
    setSelectedProfileId(nextProfileId);
    setExpandedMessageId(null);
    await saveActiveProfileId(nextProfileId);

    const nextProfile = profiles.find((profile) => profile.id === nextProfileId);
    if (nextProfile?.inbox?.address.trim()) {
      await refreshProfileInbox(nextProfile, nextProfileId, { silent: true });
    }
  }

  async function handleGenerateAlias() {
    if (!selectedProfile) {
      setFeedback({ type: "error", message: "请先在设置页添加 Duck。" });
      return;
    }

    if (!selectedProfile.duck.token.trim()) {
      setFeedback({ type: "error", message: "请先在设置页保存 Duck token。" });
      return;
    }

    setBusyAction("generate");

    try {
      const alias = await createDuckAlias(selectedProfile.duck);
      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? {
              ...profile,
              aliases: [alias, ...profile.aliases.filter((item) => item.id !== alias.id)],
              currentAliasId: alias.id,
              updatedAt: new Date().toISOString()
            }
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setExpandedMessageId(null);
      setFeedback({ type: "success", message: `已生成 ${alias.address}` });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "生成邮箱失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateInbox(customPrefix?: string) {
    if (!selectedProfile) {
      setFeedback({ type: "error", message: "请先在设置页添加 Temp Mail 配置。" });
      return;
    }

    const createDomain = resolveTempMailCreateDomain(selectedProfile.tempMail);

    if (!selectedProfile.tempMail.baseUrl.trim() || !createDomain) {
      setFeedback({ type: "error", message: "请先在设置页填写 Temp Mail Base URL，并至少配置一个域名。" });
      return;
    }

    setBusyAction("generate");

    try {
      const inbox = await createTempMailInbox(
        {
          ...selectedProfile.tempMail,
          domain: createDomain
        },
        customPrefix?.trim() || undefined
      );
      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? syncCurrentTempMailInboxState(
              {
                ...profile,
                inbox
              },
              () => buildTempMailInboxState(inbox)
            )
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setExpandedMessageId(null);
      setMailboxInputValue("");
      setFeedback({
        type: "success",
        message: `${customPrefix?.trim() ? "已创建" : "已随机生成"} ${inbox.address}，请刷新同步这个邮箱的邮件`
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "创建收件箱失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSelectTempMailInbox(inboxKey: string) {
    if (!selectedProfile || !isTempMailMode) {
      return;
    }

    const nextInbox = tempMailHistoryOptions.find(
      (item) => (item.addressJwt || item.address) === inboxKey
    );

    if (!nextInbox || sameTempMailInbox(selectedProfile.inbox, nextInbox)) {
      return;
    }

    const nextProfiles = profiles.map((profile) =>
      profile.id === selectedProfile.id
        ? syncCurrentTempMailInboxState(
            {
              ...profile,
              inbox: nextInbox
            },
            (state) => state
          )
        : profile
    );

    await persistProfiles(nextProfiles, selectedProfile.id);
    setExpandedMessageId(null);
    setMailboxInputValue("");
    await refreshProfileInbox(
      {
        ...selectedProfile,
        inbox: nextInbox
      },
      selectedProfile.id,
      { silent: true }
    );
    setFeedback({ type: "info", message: `已切换到 ${nextInbox.address}` });
  }

  function handleMailboxInputChange(value: string) {
    setMailboxInputValue(value.trim().toLowerCase());
  }

  async function handleCustomCreateInbox() {
    if (!selectedProfile || !isTempMailMode) {
      return;
    }

    if (!normalizedCustomMailboxInput) {
      setFeedback({ type: "error", message: "请输入固定邮箱前缀。" });
      return;
    }

    await handleCreateInbox(normalizedCustomMailboxInput);
  }

  async function handleChangeTempMailDomain(nextDomain: string) {
    if (!selectedProfile || !isTempMailMode) {
      return;
    }

    const nextProfiles = profiles.map((profile) =>
      profile.id === selectedProfile.id
        ? {
            ...profile,
            tempMail: {
              ...profile.tempMail,
              domain: normalizeTempMailDomainSelection(
                nextDomain,
                getTempMailConfiguredDomains(profile.tempMail)
              )
            },
            updatedAt: new Date().toISOString()
          }
        : profile
    );

    await persistProfiles(nextProfiles, selectedProfile.id);
  }

  async function handleToggleAutoRefresh() {
    if (!selectedProfile) {
      return;
    }

    const nextEnabled = !selectedProfile.tempMail.autoRefreshEnabled;
    const nextProfiles = profiles.map((profile) =>
      profile.id === selectedProfile.id
        ? {
            ...profile,
            tempMail: {
              ...profile.tempMail,
              autoRefreshEnabled: nextEnabled
            },
            updatedAt: new Date().toISOString()
          }
        : profile
    );

    await persistProfiles(nextProfiles, selectedProfile.id);
    const effectiveIntervalMs = getEffectiveAutoRefreshIntervalMs(selectedProfile.tempMail.pollIntervalMs);
    setFeedback({
      type: "info",
      message: nextEnabled
        ? `已开启自动刷新，当前按 ${effectiveIntervalMs}ms 刷新当前邮箱`
        : "已关闭自动刷新"
    });
  }

  async function refreshCurrentInbox(options?: { silent?: boolean }) {
    if (!selectedProfile) {
      if (!options?.silent) {
        setFeedback({ type: "error", message: "请先在设置页添加 Duck。" });
      }
      return;
    }

    await refreshProfileInbox(selectedProfile, selectedProfile.id, options);
  }

  async function handleRefreshMessages() {
    await refreshCurrentInbox();
  }

  useEffect(() => {
    if (
      !selectedProfile?.tempMail.autoRefreshEnabled ||
      !selectedProfile.inbox?.address.trim()
    ) {
      return;
    }

    const intervalMs = getEffectiveAutoRefreshIntervalMs(selectedProfile.tempMail.pollIntervalMs);
    const timer = window.setInterval(() => {
      void refreshCurrentInbox({ silent: true });
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    busyAction,
    selectedProfile?.id,
    selectedProfile?.inbox?.address,
    selectedProfile?.inbox?.addressJwt,
    selectedProfile?.tempMail.autoRefreshEnabled,
    selectedProfile?.tempMail.pollIntervalMs
  ]);

  async function handleCopyEmail(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!currentMailboxAddress) {
      const frameRect = frameRef.current?.getBoundingClientRect();
      setCopyHint({
        x: frameRect ? event.clientX - frameRect.left : 160,
        y: frameRect ? event.clientY - frameRect.top : 120,
        message: "暂无可复制邮箱",
        tone: "error"
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(currentMailboxAddress);
      const frameRect = frameRef.current?.getBoundingClientRect();
      setCopyHint({
        x: frameRect ? event.clientX - frameRect.left : 160,
        y: frameRect ? event.clientY - frameRect.top : 120,
        message: "已复制",
        tone: "success"
      });
    } catch {
      const frameRect = frameRef.current?.getBoundingClientRect();
      setCopyHint({
        x: frameRect ? event.clientX - frameRect.left : 160,
        y: frameRect ? event.clientY - frameRect.top : 120,
        message: "复制失败",
        tone: "error"
      });
    }
  }

  async function handleToggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    await savePopupTheme(nextTheme);
  }

  function openOptionsPage() {
    void chrome.runtime.openOptionsPage();
  }

  async function markMessageAsRead(messageId: string) {
    if (!selectedProfile || readMessageIds.includes(messageId)) {
      return;
    }

    const nextProfiles = profiles.map((profile) =>
      profile.id === selectedProfile.id
        ? syncCurrentTempMailInboxState(profile, (state) => ({
            ...state,
            readMessageIds: Array.from(new Set([...state.readMessageIds, messageId]))
          }))
        : profile
    );

    setProfiles(nextProfiles);
    await saveProfiles(nextProfiles);
  }

  async function handleToggleMessage(messageId: string) {
    const selectedText = window.getSelection()?.toString().trim();
    if (selectedText) {
      return;
    }

    const nextExpandedId = expandedMessageId === messageId ? null : messageId;
    setExpandedMessageId(nextExpandedId);

    if (nextExpandedId) {
      await markMessageAsRead(messageId);
    }
  }

  if (loading) {
    return (
      <main className="popup-frame popup-theme-dark">
        <div className="status-banner info">正在加载...</div>
      </main>
    );
  }

  if (!selectedProfile) {
    return (
      <main className={`popup-frame ${theme === "light" ? "popup-theme-light" : "popup-theme-dark"}`}>
        <div className="popup-header">
          <div className="popup-brand">Duck Mailbox</div>
          <div className="popup-icon-actions">
            <button className="popup-icon-button" onClick={() => void handleToggleTheme()} title="切换主题">
              ◐
            </button>
            <button className="popup-icon-button" onClick={openOptionsPage} title="设置">
              ⚙
            </button>
          </div>
        </div>
        <div className="empty-state">先去设置页添加一个 Duck 配置。</div>
      </main>
    );
  }

  return (
    <main
      ref={frameRef}
      className={`popup-frame ${theme === "light" ? "popup-theme-light" : "popup-theme-dark"}`}
    >
      <header className="popup-header">
        <div className="popup-brand">Duck Mailbox</div>
        <div className="popup-icon-actions">
          <button className="popup-icon-button" onClick={() => void handleToggleTheme()} title="切换主题">
            ◐
          </button>
          <button className="popup-icon-button" onClick={openOptionsPage} title="设置">
            ⚙
          </button>
        </div>
      </header>

      {feedback ? (
        <div className={`popup-toast ${feedback.type}`} role="status" aria-live="polite">
          <span className="popup-toast-badge">{getFeedbackBadge(feedback.type)}</span>
          <span className="popup-toast-message">{feedback.message}</span>
          <button
            type="button"
            className="popup-toast-close"
            onClick={() => setFeedback(null)}
            title="关闭提示"
          >
            ×
          </button>
        </div>
      ) : null}
      {copyHint ? (
        <div
          className={`popup-copy-hint ${copyHint.tone}`}
          style={{ left: `${copyHint.x}px`, top: `${copyHint.y}px` }}
          role="status"
          aria-live="polite"
        >
          {copyHint.message}
        </div>
      ) : null}

      <section className="popup-panel">
        <div className="popup-workspace">
          <div className="popup-toolbar-row">
            <div className="popup-select-shell popup-profile-select">
              <select
                value={selectedProfile.id}
                onChange={(event) => {
                  void handleSelectProfile(event.target.value);
                }}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="popup-action-cluster">
              <button
                className="popup-mini-button primary"
                disabled={busyAction !== null}
                onClick={() => void (isTempMailMode ? handleCreateInbox() : handleGenerateAlias())}
                title={isTempMailMode ? "随机生成收件箱" : "生成邮箱"}
              >
                +
              </button>
              <button
                className="popup-mini-button"
                disabled={busyAction !== null}
                onClick={() => void handleRefreshMessages()}
                title="刷新邮件"
              >
                ↻
              </button>
              <button
                className={`popup-mini-button ${selectedProfile.tempMail.autoRefreshEnabled ? "is-active" : "is-inactive"}`}
                disabled={busyAction !== null}
                onClick={() => void handleToggleAutoRefresh()}
                title={selectedProfile.tempMail.autoRefreshEnabled ? "关闭自动刷新" : "开启自动刷新"}
                aria-pressed={selectedProfile.tempMail.autoRefreshEnabled}
              >
                {selectedProfile.tempMail.autoRefreshEnabled ? "◉" : "◌"}
              </button>
            </div>
          </div>

          {isTempMailMode ? (
            <div className="popup-tempmail-tools">
              <div className="popup-tempmail-custom-row">
                <div className="popup-mailbox-combobox">
                  <input
                    className="popup-mailbox-combobox-input"
                    value={mailboxInputValue}
                    onChange={(event) => handleMailboxInputChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleCustomCreateInbox();
                      }
                    }}
                    placeholder="输入邮箱前缀"
                  />
                </div>
                <div className="popup-select-shell">
                  <select
                    value={
                      selectedTempMailDomainValue ||
                      (tempMailDomains.length ? tempMailDomains[0] : "")
                    }
                    onChange={(event) => void handleChangeTempMailDomain(event.target.value)}
                  >
                    {tempMailDomains.length ? (
                      <>
                        {tempMailDomains.map((domain) => (
                          <option key={domain} value={domain}>
                            {domain}
                          </option>
                        ))}
                        <option value={TEMP_MAIL_ANY_DOMAIN}>任意（随机域名）</option>
                      </>
                    ) : (
                      <option value="">请先配置域名</option>
                    )}
                  </select>
                </div>
                <button
                  type="button"
                  className="popup-mini-button popup-mini-button-wide"
                  disabled={busyAction !== null}
                  onClick={() => void handleCustomCreateInbox()}
                  title="创建固定格式邮箱"
                >
                  创建
                </button>
              </div>

              <div className="popup-tempmail-history-row">
                <div className="popup-select-shell">
                  <select
                    value={tempMailHistorySelectValue}
                    onChange={(event) => void handleSelectTempMailInbox(event.target.value)}
                  >
                    {tempMailHistoryOptions.length ? (
                      tempMailHistoryOptions.map((inbox) => (
                        <option key={inbox.addressJwt || inbox.address} value={inbox.addressJwt || inbox.address}>
                          {inbox.address}
                        </option>
                      ))
                    ) : (
                      <option value="">还没有历史邮箱</option>
                    )}
                  </select>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {!isTempMailMode ? (
          <div className="popup-mailbox-strip">
            <div className="popup-mailbox-top">
              <div className="popup-mailbox-label">当前邮箱</div>
              <div className="popup-mailbox-meta">
                {selectedProfile.lastSyncedAt
                ? formatAbsoluteDateTime(selectedProfile.lastSyncedAt)
                : "未同步"}
              </div>
            </div>
            <button
              type="button"
              className="popup-mailbox-row popup-mailbox-copy"
              disabled={!currentMailboxAddress}
              onClick={(event) => void handleCopyEmail(event)}
              title={currentMailboxAddress ? "点击复制邮箱地址" : currentMailboxPlaceholder}
            >
              <div className="popup-mailbox-value">
                {currentMailboxAddress || currentMailboxPlaceholder}
              </div>
            </button>
          </div>
        ) : (
          <div className="popup-tempmail-meta">
            <div className="popup-tempmail-meta-main">
              <span className="popup-tempmail-meta-label">当前邮箱</span>
              <button
                type="button"
                className="popup-tempmail-copy"
                disabled={!currentMailboxAddress}
                onClick={(event) => void handleCopyEmail(event)}
                title={currentMailboxAddress ? "点击复制邮箱地址" : currentMailboxPlaceholder}
              >
                <span className="popup-tempmail-copy-value">
                  {currentMailboxAddress || currentMailboxPlaceholder}
                </span>
                {currentMailboxAddress ? <span className="popup-tempmail-copy-action">复制</span> : null}
              </button>
            </div>
            {selectedProfile.lastSyncedAt ? (
              <span className="popup-tempmail-meta-time">
                <span>{formatListDateTime(selectedProfile.lastSyncedAt).date}</span>
                <span>{formatListDateTime(selectedProfile.lastSyncedAt).time}</span>
              </span>
            ) : (
              <span className="popup-tempmail-meta-time">
                <span>未同步</span>
              </span>
            )}
          </div>
        )}
      </section>

      <section className="popup-panel">
        <div className="popup-list-head">
          <h2>邮件列表</h2>
          <div className="popup-badge">{selectedProfile.messages.length}</div>
        </div>

        {selectedProfile.messages.length ? (
          <div className="popup-mail-list">
            {selectedProfile.messages.map((message) => {
              const messageTime = formatListDateTime(message.receivedAt);
              const hasHtmlContent = Boolean(message.htmlContent?.trim());
              const textContent = normalizePlainTextContent(
                message.content || message.raw || message.preview || "暂无邮件内容"
              );
              const viewMode = getMessageViewMode(message.id, hasHtmlContent);

              return (
              <article
                key={message.id}
                className={`popup-mail-card ${expandedMessageId === message.id ? "is-expanded" : ""} ${
                  readMessageIds.includes(message.id) ? "is-read" : "is-unread"
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className="popup-mail-trigger"
                  onClick={() => void handleToggleMessage(message.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void handleToggleMessage(message.id);
                    }
                  }}
                >
                  <div className="popup-mail-main">
                    <div className="popup-mail-body">
                      <div className="popup-mail-title-row">
                        {!readMessageIds.includes(message.id) ? (
                          <span className="popup-unread-dot" aria-hidden="true"></span>
                        ) : null}
                        <h3 className="popup-mail-title" title={message.subject}>
                          {message.subject}
                        </h3>
                      </div>
                      <div className="popup-mail-from">
                        {extractMailbox(message.sourceAddress || message.from)}
                      </div>
                      <div className="popup-mail-preview">{message.preview || "暂无摘要"}</div>
                    </div>
                    <div className="popup-mail-side">
                      <div className="popup-mail-time" title={formatAbsoluteDateTime(message.receivedAt)}>
                        {messageTime.date ? <span>{messageTime.date}</span> : null}
                        <strong>{messageTime.time}</strong>
                      </div>
                      <div className="popup-mail-chevron">
                        {expandedMessageId === message.id ? "⌃" : "⌄"}
                      </div>
                    </div>
                  </div>
                </div>
                {expandedMessageId === message.id ? (
                  <div className="popup-mail-detail">
                    <div className="popup-mail-route">
                      <span>{extractMailbox(message.sourceAddress || message.from)}</span>
                      <span className="popup-mail-route-arrow">→</span>
                      <span>{message.recipientAddress || selectedProfile.inbox?.address || "未知收件地址"}</span>
                    </div>
                    <div className="popup-raw-box">
                      <div className="popup-mail-content-head">
                        <span>邮件内容</span>
                        {hasHtmlContent ? (
                          <div className="popup-view-switch" role="tablist" aria-label="邮件视图切换">
                            <button
                              type="button"
                              className={`popup-view-switch-button ${viewMode === "html" ? "is-active" : ""}`}
                              onClick={() => handleChangeMessageView(message.id, "html")}
                              aria-pressed={viewMode === "html"}
                            >
                              HTML
                            </button>
                            <button
                              type="button"
                              className={`popup-view-switch-button ${viewMode === "text" ? "is-active" : ""}`}
                              onClick={() => handleChangeMessageView(message.id, "text")}
                              aria-pressed={viewMode === "text"}
                            >
                              纯文本
                            </button>
                          </div>
                        ) : null}
                      </div>
                      {viewMode === "html" && message.htmlContent ? (
                        <EmailHtmlFrame
                          html={message.htmlContent}
                          title={`${message.subject || "邮件"} HTML 视图`}
                          theme={theme}
                          inlineResourceMap={message.inlineResourceMap}
                          className="popup-html-frame"
                        />
                      ) : (
                        <pre>{textContent}</pre>
                      )}
                    </div>
                  </div>
                ) : null}
              </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">当前没有邮件，点击刷新后会在这里显示。</div>
        )}
      </section>
    </main>
  );
}
