import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { createDuckAlias } from "../features/ddg/client";
import { fetchTempMailMessageSummaries } from "../features/temp-mail/client";
import {
  PopupTheme,
  loadActiveProfileId,
  loadPopupTheme,
  loadProfiles,
  saveActiveProfileId,
  savePopupTheme,
  saveProfiles
} from "../shared/storage/local";
import { DuckProfile } from "../shared/types/profile";

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

function extractMailbox(value: string) {
  const bracketMatch = value.match(/<([^>]+)>/);

  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch?.[0] || value.trim();
}

function normalizePlainTextContent(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildEmailHtmlDocument(html: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");

  for (const element of Array.from(document.querySelectorAll("script, iframe, object, embed"))) {
    element.remove();
  }

  for (const metaRefresh of Array.from(document.querySelectorAll('meta[http-equiv="refresh" i]'))) {
    metaRefresh.remove();
  }

  for (const formElement of Array.from(
    document.querySelectorAll("form, button, input, select, textarea")
  )) {
    formElement.replaceWith(...Array.from(formElement.childNodes));
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];

  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element);
  }

  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value.trim();

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (attributeName === "href") {
        if (
          !/^https?:/i.test(attributeValue) &&
          !/^mailto:/i.test(attributeValue) &&
          !/^tel:/i.test(attributeValue) &&
          !/^#/i.test(attributeValue)
        ) {
          element.removeAttribute(attribute.name);
          continue;
        }

        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
      }
    }
  }

  const head = document.head.innerHTML.trim();
  const body = document.body.innerHTML.trim();

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
      }
    </style>
    ${head}
    <style>

      body {
        overflow-wrap: break-word;
      }

      img {
        max-width: 100% !important;
        height: auto !important;
      }

      table {
        max-width: 100% !important;
      }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

type EmailHtmlFrameProps = {
  html: string;
  title: string;
};

function EmailHtmlFrame({ html, title }: EmailHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState(320);
  const srcDoc = buildEmailHtmlDocument(html);

  function syncFrameHeight() {
    const iframe = iframeRef.current;
    const document = iframe?.contentDocument;
    const body = document?.body;
    const root = document?.documentElement;

    if (!iframe || !body || !root) {
      return;
    }

    const nextHeight = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      root.scrollHeight,
      root.offsetHeight,
      160
    );

    setFrameHeight(nextHeight);
  }

  function handleLoad() {
    syncFrameHeight();

    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    for (const image of Array.from(document.images)) {
      if (image.complete) {
        continue;
      }

      image.addEventListener("load", syncFrameHeight, { once: true });
      image.addEventListener("error", syncFrameHeight, { once: true });
    }

    window.setTimeout(syncFrameHeight, 60);
    window.setTimeout(syncFrameHeight, 220);
    window.setTimeout(syncFrameHeight, 600);
  }

  useEffect(() => {
    setFrameHeight(320);
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      className="popup-html-frame"
      title={title}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      loading="lazy"
      srcDoc={srcDoc}
      style={{ height: `${frameHeight}px` }}
      onLoad={handleLoad}
    />
  );
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

  useEffect(() => {
    if (!selectedProfile) {
      setExpandedMessageId(null);
      setMessageViewModes({});
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
  }, [selectedProfile]);

  function getMessageViewMode(messageId: string, hasHtmlContent: boolean): MessageViewMode {
    if (!hasHtmlContent) {
      return "text";
    }

    return messageViewModes[messageId] || "html";
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

  async function handleRefreshMessages() {
    if (!selectedProfile) {
      setFeedback({ type: "error", message: "请先在设置页添加 Duck。" });
      return;
    }

    if (!selectedProfile.inbox?.addressJwt.trim()) {
      setFeedback({ type: "error", message: "请先在设置页填写 Temp Mail token。" });
      return;
    }

    setBusyAction("refresh");

    try {
      const messages = await fetchTempMailMessageSummaries({
        ...selectedProfile.tempMail,
        ...selectedProfile.inbox
      });

      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? {
              ...profile,
              messages,
              readMessageIds: messages
                .map((message) => message.id)
                .filter(
                  (messageId) =>
                    selectedProfile.readMessageIds.includes(messageId) &&
                    selectedProfile.messages.some((item) => item.id === messageId)
                ),
              lastSyncedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setExpandedMessageId(null);
      setFeedback({
        type: "success",
        message: messages.length ? `已同步 ${messages.length} 封邮件` : "当前没有邮件"
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "刷新邮件失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopyEmail(event: ReactMouseEvent<HTMLButtonElement>) {
    if (!currentAlias?.address) {
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
      await navigator.clipboard.writeText(currentAlias.address);
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
        ? {
            ...profile,
            readMessageIds: [...profile.readMessageIds, messageId]
          }
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
        <div className="popup-control-grid">
          <div className="popup-select-shell">
            <select
              value={selectedProfile.id}
              onChange={(event) => {
                const nextProfileId = event.target.value;
                setSelectedProfileId(nextProfileId);
                setExpandedMessageId(null);
                void saveActiveProfileId(event.target.value);
              }}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="popup-mini-button primary"
            disabled={busyAction !== null}
            onClick={() => void handleGenerateAlias()}
            title="生成邮箱"
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
        </div>

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
            disabled={!currentAlias?.address}
            onClick={(event) => void handleCopyEmail(event)}
            title={currentAlias?.address ? "点击复制邮箱地址" : "还没有生成 Duck 邮箱"}
          >
            <div className="popup-mailbox-value">
              {currentAlias?.address || "还没有生成 Duck 邮箱"}
            </div>
          </button>
        </div>
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
