import { ChangeEvent, useEffect, useMemo, useState } from "react";

import { CardSection } from "../shared/components/CardSection";
import { createDuckAlias } from "../features/ddg/client";
import {
  createTempMailInbox,
  fetchTempMailMessageSummaries
} from "../features/temp-mail/client";
import {
  createEmptyProfile,
  loadActiveProfileId,
  loadProfiles,
  saveActiveProfileId,
  saveProfiles
} from "../shared/storage/local";
import { DuckAlias } from "../shared/types/duck";
import { DuckProfile } from "../shared/types/profile";

type Notice = {
  type: "success" | "error" | "info";
  message: string;
};

type BusyAction = "save" | "alias" | "inbox" | "sync" | null;

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

export function OptionsApp() {
  const [profiles, setProfiles] = useState<DuckProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);

  useEffect(() => {
    async function hydrate() {
      const [storedProfiles, activeProfileId] = await Promise.all([
        loadProfiles(),
        loadActiveProfileId()
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

      if (!storedProfiles.length) {
        await saveProfiles(fallbackProfiles);
      }

      await saveActiveProfileId(nextSelectedId);
      setLoading(false);
    }

    void hydrate();
  }, []);

  const selectedProfile = useMemo(
    () => getSelectedProfile(profiles, selectedProfileId),
    [profiles, selectedProfileId]
  );

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

  async function handleCreateProfile() {
    const profile = createEmptyProfile(`Duck ${profiles.length + 1}`);
    const nextProfiles = [profile, ...profiles];
    await persistProfiles(nextProfiles, profile.id);
    setNotice({ type: "success", message: "已新增一个 Duck 配置。" });
  }

  async function handleSaveProfile() {
    if (!selectedProfile) {
      return;
    }

    if (!selectedProfile.name.trim()) {
      setNotice({ type: "error", message: "请先填写 Duck 名称。" });
      return;
    }

    if (!selectedProfile.duck.token.trim()) {
      setNotice({ type: "error", message: "请先填写 Duck token。" });
      return;
    }

    if (!selectedProfile.tempMail.baseUrl.trim() || !selectedProfile.tempMail.domain.trim()) {
      setNotice({
        type: "error",
        message: "请至少填写 Temp Mail Base URL 和 Domain。"
      });
      return;
    }

    setBusyAction("save");

    try {
      const nextProfiles = profiles.map((profile) => {
        if (profile.id !== selectedProfile.id) {
          return profile;
        }

        return updateProfileTimestamp({
          ...selectedProfile,
          name: selectedProfile.name.trim(),
          duck: {
            ...selectedProfile.duck,
            apiBaseUrl: normalizeUrl(selectedProfile.duck.apiBaseUrl),
            token: selectedProfile.duck.token.trim(),
            aliasDomain: selectedProfile.duck.aliasDomain.trim()
          },
          tempMail: {
            ...selectedProfile.tempMail,
            baseUrl: normalizeUrl(selectedProfile.tempMail.baseUrl),
            adminAuth: selectedProfile.tempMail.adminAuth.trim(),
            customAuth: selectedProfile.tempMail.customAuth.trim(),
            domain: selectedProfile.tempMail.domain.trim(),
            namePrefix: selectedProfile.tempMail.namePrefix.trim(),
            pollIntervalMs: parseNumber(
              String(selectedProfile.tempMail.pollIntervalMs),
              selectedProfile.tempMail.pollIntervalMs
            ),
            pollTimeoutMs: parseNumber(
              String(selectedProfile.tempMail.pollTimeoutMs),
              selectedProfile.tempMail.pollTimeoutMs
            )
          },
          inbox: selectedProfile.inbox
            ? {
                ...selectedProfile.inbox,
                address: selectedProfile.inbox.address.trim(),
                addressJwt: selectedProfile.inbox.addressJwt.trim()
              }
            : null
        });
      });

      await persistProfiles(nextProfiles, selectedProfile.id);
      setNotice({ type: "success", message: "当前 Duck 配置已保存。" });
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
      setNotice({ type: "error", message: "请先填写并保存 Temp Mail 配置。" });
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
      setNotice({ type: "error", message: "请先填写或创建 Temp Mail 收件箱 token。" });
      return;
    }

    setBusyAction("sync");

    try {
      const messages = await fetchTempMailMessageSummaries({
        ...selectedProfile.tempMail,
        ...selectedProfile.inbox
      });

      const nextProfiles = profiles.map((profile) =>
        profile.id === selectedProfile.id
          ? updateProfileTimestamp({
              ...profile,
              messages,
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
        <div className="status-banner info">正在加载 Duck 配置...</div>
      </main>
    );
  }

  const currentAlias =
    selectedProfile.aliases.find((item) => item.id === selectedProfile.currentAliasId) ||
    selectedProfile.aliases[0] ||
    null;

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="app-eyebrow">Settings</p>
        <h1>Duck 配置与收件设置</h1>
        <p className="page-description">
          一个 Duck 对应一个 Temp Mail 收件配置。主页只负责切换和看邮件，这里负责所有配置与同步动作。
        </p>
      </header>

      {notice ? <div className={`status-banner ${notice.type}`}>{notice.message}</div> : null}

      <div className="settings-layout">
        <aside className="profile-sidebar">
          <div className="sidebar-head">
            <strong>Duck 列表</strong>
            <button className="ghost-button" onClick={() => void handleCreateProfile()}>
              新增 Duck
            </button>
          </div>
          <div className="profile-list">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`profile-chip ${profile.id === selectedProfile.id ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedProfileId(profile.id);
                  void saveActiveProfileId(profile.id);
                }}
              >
                <strong>{profile.name}</strong>
                <span>{profile.aliases[0]?.address || "还没有 Duck 地址"}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="settings-main">
          <CardSection
            title="当前 Duck"
            description="每个 Duck Profile 绑定一套 Duck token 和 Temp Mail 收件配置。"
          >
            <div className="field-grid two-columns">
              <label className="field-card">
                <span>Duck 名称</span>
                <input
                  value={selectedProfile.name}
                  onChange={(event) =>
                    updateSelectedProfile((profile) => ({
                      ...profile,
                      name: event.target.value
                    }))
                  }
                />
              </label>
              <label className="field-card">
                <span>当前 Duck 地址</span>
                <input value={currentAlias?.address || "还没有生成"} readOnly />
              </label>
            </div>
          </CardSection>

          <CardSection
            title="DuckDuckGo 配置"
            description="用于生成当前 Duck 对应的 `@duck.com` 别名。"
          >
            <div className="field-grid two-columns">
              <label className="field-card">
                <span>API Base URL</span>
                <input
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
              <label className="field-card">
                <span>Token</span>
                <input
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
              <label className="field-card">
                <span>Alias Domain</span>
                <input
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
            </div>
          </CardSection>

          <CardSection
            title="Temp Mail 配置"
            description="当前只支持 Temp Mail 一种收件协议。"
          >
            <div className="field-grid two-columns">
              <label className="field-card">
                <span>Base URL</span>
                <input
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
              <label className="field-card">
                <span>Admin Auth</span>
                <input
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
              <label className="field-card">
                <span>Custom Auth</span>
                <input
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
                />
              </label>
              <label className="field-card">
                <span>Domain</span>
                <input
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
              <label className="field-card">
                <span>Name Prefix</span>
                <input
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
              <label className="field-card">
                <span>轮询间隔（ms）</span>
                <input
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
              <label className="field-card">
                <span>轮询超时（ms）</span>
                <input
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
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={selectedProfile.tempMail.enablePrefix}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateSelectedProfile((profile) => ({
                    ...profile,
                    tempMail: {
                      ...profile.tempMail,
                      enablePrefix: event.target.checked
                    }
                  }))
                }
              />
              <span>创建地址时启用前缀</span>
            </label>
          </CardSection>

          <CardSection
            title="收件箱 Token"
            description="你也可以手动填 Temp Mail 的收件邮箱和 token，不一定要自动创建。这里要填邮箱地址，不要填站点 URL。"
          >
            <div className="field-grid two-columns">
              <label className="field-card">
                <span>Temp Mail Address</span>
                <input
                  value={selectedProfile.inbox?.address || ""}
                  onChange={(event) =>
                    updateSelectedProfile((profile) => ({
                      ...profile,
                      inbox: {
                        address: event.target.value,
                        addressJwt: profile.inbox?.addressJwt || "",
                        createdAt: profile.inbox?.createdAt || new Date().toISOString()
                      }
                    }))
                  }
                  placeholder="例如 inbox@temp-email.evil.de5.net"
                />
              </label>
              <label className="field-card">
                <span>Temp Mail Token / JWT</span>
                <input
                  value={selectedProfile.inbox?.addressJwt || ""}
                  onChange={(event) =>
                    updateSelectedProfile((profile) => ({
                      ...profile,
                      inbox: {
                        address: profile.inbox?.address || "",
                        addressJwt: event.target.value,
                        createdAt: profile.inbox?.createdAt || new Date().toISOString()
                      }
                    }))
                  }
                  placeholder="粘贴 addressJwt"
                />
              </label>
            </div>
          </CardSection>

          <CardSection
            title="操作区"
            description="所有生成、收件箱创建和同步操作都放在设置页。"
          >
            <div className="action-row">
              <button
                className="primary-button"
                disabled={busyAction !== null}
                onClick={() => void handleSaveProfile()}
              >
                {busyAction === "save" ? "保存中..." : "保存当前 Duck"}
              </button>
              <button
                className="secondary-button"
                disabled={busyAction !== null}
                onClick={() => void handleGenerateAlias()}
              >
                {busyAction === "alias" ? "生成中..." : "生成 Duck 地址"}
              </button>
              <button
                className="secondary-button"
                disabled={busyAction !== null}
                onClick={() => void handleCreateInbox()}
              >
                {busyAction === "inbox" ? "创建中..." : "自动创建 Temp 收件箱"}
              </button>
              <button
                className="secondary-button"
                disabled={busyAction !== null}
                onClick={() => void handleSyncMessages()}
              >
                {busyAction === "sync" ? "同步中..." : "同步当前 Duck 邮件"}
              </button>
            </div>
          </CardSection>
        </div>
      </div>
    </main>
  );
}
