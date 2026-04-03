import { useEffect, useMemo, useState } from "react";

import { createDuckAlias } from "../features/ddg/client";
import {
  createTempMailInbox,
  fetchTempMailMessageSummaries
} from "../features/temp-mail/client";
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
import { DuckProfile, ProfileMode } from "../shared/types/profile";
import { TempMailInbox } from "../shared/types/tempMail";

type Notice = {
  type: "success" | "error" | "info";
  message: string;
};

type BusyAction = "save" | "alias" | "inbox" | "sync" | null;
type PanelView = "edit" | "status";

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

function getUnreadCount(profile: DuckProfile) {
  return profile.messages.filter((message) => !profile.readMessageIds.includes(message.id)).length;
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

function sanitizeEmailHtml(html: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  const allowedTags = new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "div",
    "em",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul"
  ]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];

  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element);
  }

  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();

    if (!allowedTags.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value.trim();

      if (attributeName.startsWith("on") || attributeName === "style" || attributeName === "src") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (attributeName === "href") {
        if (!/^https?:/i.test(attributeValue) && !/^mailto:/i.test(attributeValue)) {
          element.removeAttribute(attribute.name);
          continue;
        }

        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
        continue;
      }

      if (!["href", "target", "rel", "colspan", "rowspan"].includes(attributeName)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return document.body.innerHTML.trim();
}

function StatusMailList({
  messages,
  readMessageIds
}: {
  messages: MailSummary[];
  readMessageIds: string[];
}) {
  if (!messages.length) {
    return (
      <div className="mode-empty-state">
        当前还没有同步到邮件。进入状态页后可以直接点“立即同步”查看最新内容。
      </div>
    );
  }

  return (
    <div className="mode-mail-list">
      {messages.map((message) => {
        const datetime = formatListDateTime(message.receivedAt);
        const isUnread = !readMessageIds.includes(message.id);

        return (
          <details key={message.id} className={`mode-mail-card ${isUnread ? "is-unread" : ""}`}>
            <summary className="mode-mail-summary">
              <div className="mode-mail-main">
                <div className="mode-mail-copy">
                  <div className="mode-mail-title-row">
                    <h4 className="mode-mail-title">{message.subject || "无主题"}</h4>
                    {isUnread ? <span className="mode-mail-badge">未读</span> : null}
                  </div>
                  <div className="mode-mail-from">{message.from || "未知发件人"}</div>
                  <div className="mode-mail-preview">{message.preview || "暂无摘要"}</div>
                </div>
                <div className="mode-mail-side">
                  {datetime.date ? <span>{datetime.date}</span> : null}
                  <strong>{datetime.time}</strong>
                </div>
              </div>
            </summary>

            <div className="mode-mail-detail">
              <div className="mode-mail-route">
                <span>{message.sourceAddress || message.from || "未知发件人"}</span>
                <span className="mode-mail-route-arrow">→</span>
                <span>{message.recipientAddress || message.address}</span>
              </div>

              {message.htmlContent ? (
                <div
                  className="mode-mail-body html"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeEmailHtml(message.htmlContent)
                  }}
                />
              ) : (
                <div className="mode-mail-body text">
                  {message.content || message.preview || "暂无正文"}
                </div>
              )}
            </div>
          </details>
        );
      })}
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

  const selectedProfile = getSelectedProfile(profiles, selectedProfileId);

  const stats = useMemo(() => {
    if (!selectedProfile) {
      return {
        total: 0,
        unread: 0,
        currentAddress: "未选择配置"
      };
    }

    return {
      total: selectedProfile.messages.length,
      unread: getUnreadCount(selectedProfile),
      currentAddress: getProfileAddress(selectedProfile)
    };
  }, [selectedProfile]);

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
          ? updateProfileTimestamp({
              ...profile,
              inbox
            })
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setNotice({ type: "success", message: `已创建收件箱：${inbox.address}` });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "创建 Temp 收件箱失败。"
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSyncMessages() {
    if (!selectedProfile || !selectedProfile.inbox?.addressJwt.trim()) {
      setNotice({ type: "error", message: "请先创建或填写收件箱信息。" });
      return;
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
      const messages = await fetchTempMailMessageSummaries({
        ...normalizedProfile.tempMail,
        ...inbox
      });

      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? updateProfileTimestamp({
              ...profile,
              tempMail: normalizedProfile.tempMail,
              messages,
              readMessageIds: profile.readMessageIds.filter((id) =>
                messages.some((message) => message.id === id)
              ),
              lastSyncedAt: new Date().toISOString()
            })
          : profile
      );

      await persistProfiles(nextProfiles, selectedProfile.id);
      setNotice({
        type: "success",
        message: messages.length ? `已同步 ${messages.length} 封邮件。` : "当前没有同步到邮件。"
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
                    <strong>{formatAbsoluteDateTime(selectedProfile.lastSyncedAt)}</strong>
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
                </div>

                <div className="mode-mail-counter">
                  <span className="mode-status-pill">
                    总数
                    <strong>{stats.total}</strong>
                  </span>
                  <span className="mode-status-pill">
                    未读
                    <strong>{stats.unread}</strong>
                  </span>
                </div>

                <StatusMailList
                  messages={selectedProfile.messages}
                  readMessageIds={selectedProfile.readMessageIds}
                />
              </section>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
