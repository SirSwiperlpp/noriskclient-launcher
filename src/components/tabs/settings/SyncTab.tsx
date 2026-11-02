"use client";

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/buttons/Button";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { SettingsSection } from "../../ui/settings/SettingsSection";
import { SettingRow } from "../../ui/settings/SettingRow";
import { useSettingsConfig, useSettingsKeywords } from "./settings-context";
import { useThemeStore } from "../../../store/useThemeStore";
import {
  testSyncConnection,
  refreshSync,
  syncNow,
  pullAllProfiles,
  listRemoteProfiles,
  pullSelectedProfiles,
  type SyncConnectionResult,
  type RemoteProfileSummary,
} from "../../../services/sync-service";
import { useSyncStore } from "../../../store/sync-store";
import { parseErrorMessage } from "../../../utils/error-utils";
import { useConfirmDialog } from "../../../hooks/useConfirmDialog";

export function SyncTab() {
  const { t } = useTranslation();
  const kw = useSettingsKeywords();
  const { config, tempConfig, setTempConfig, saving } = useSettingsConfig();
  const status = useSyncStore((s) => s.status);
  const accentColor = useThemeStore((s) => s.accentColor);
  const { confirm, confirmDialog } = useConfirmDialog();

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SyncConnectionResult | null>(null);

  const [remoteProfiles, setRemoteProfiles] = useState<RemoteProfileSummary[] | null>(null);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const enabled = tempConfig?.sync_enabled ?? false;
  const url = tempConfig?.sync_api_url ?? "";
  const apiKey = tempConfig?.sync_api_key ?? "";

  const savedEnabled = config?.sync_enabled ?? false;
  const savedUrl = config?.sync_api_url ?? "";
  const savedKey = config?.sync_api_key ?? "";

  useEffect(() => {
    refreshSync().catch(() => undefined);
  }, [savedEnabled, savedUrl, savedKey]);

  const handleTest = async () => {
    if (!url.trim()) {
      toast.error(t("settings.sync.url_required"));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testSyncConnection(url.trim(), apiKey.trim() || null);
      setTestResult(result);
      if (result.ok) {
        toast.success(
          t("settings.sync.test_ok", {
            name: result.name ?? "server",
            version: result.version ?? "",
          }),
        );
      } else {
        toast.error(t("settings.sync.test_failed", { error: result.error ?? "" }));
      }
    } catch (err) {
      const message = parseErrorMessage(err);
      setTestResult({ ok: false, name: null, version: null, error: message });
      toast.error(t("settings.sync.test_failed", { error: message }));
    } finally {
      setTesting(false);
    }
  };

  const handleSyncNow = async () => {
    try {
      await syncNow();
      toast.success(t("settings.sync.sync_started"));
    } catch (err) {
      toast.error(parseErrorMessage(err));
    }
  };

  const handlePullAll = async () => {
    const confirmed = await confirm({
      title: t("settings.sync.pull_all.button"),
      message: t("settings.sync.pull_all.confirm"),
      confirmText: t("settings.sync.pull_all.button"),
      cancelText: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) return;
    try {
      await pullAllProfiles();
      toast.success(t("settings.sync.pull_all.started"));
    } catch (err) {
      toast.error(parseErrorMessage(err));
    }
  };

  const handleLoadRemote = async () => {
    setLoadingRemote(true);
    try {
      const profiles = await listRemoteProfiles();
      setRemoteProfiles(profiles);
      // Preselect profiles that are not yet on this device — the usual intent.
      setSelectedIds(new Set(profiles.filter((p) => !p.already_local).map((p) => p.id)));
    } catch (err) {
      toast.error(parseErrorMessage(err));
    } finally {
      setLoadingRemote(false);
    }
  };

  const toggleProfile = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllRemote = () => {
    setSelectedIds(new Set((remoteProfiles ?? []).map((p) => p.id)));
  };

  const selectNoneRemote = () => {
    setSelectedIds(new Set());
  };

  const handlePullSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      toast.error(t("settings.sync.select.none_selected"));
      return;
    }
    const confirmed = await confirm({
      title: t("settings.sync.select.download", { count: ids.length }),
      message: t("settings.sync.select.confirm", { count: ids.length }),
      confirmText: t("settings.sync.select.download", { count: ids.length }),
      cancelText: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) return;
    try {
      await pullSelectedProfiles(ids);
      toast.success(t("settings.sync.select.started"));
    } catch (err) {
      toast.error(parseErrorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        id="settings-section-sync"
        title={t("settings.sync.section")}
        icon="solar:cloud-bold"
        keywords={kw("settings.sync.section", "sync", "cloud", "backup", "profiles", "worlds", "synchronisation")}
        description={t("settings.sync.enable.tooltip")}
      >
        <SettingRow
          label={t("settings.sync.enable")}
          description={t("settings.sync.enable.tooltip")}
          searchKeywords={kw("settings.sync.enable", "sync", "cloud", "enable", "aktivieren")}
          disabled={saving}
        >
          <ToggleSwitch
            checked={enabled}
            onChange={(checked) =>
              tempConfig && setTempConfig({ ...tempConfig, sync_enabled: checked })
            }
            disabled={saving}
            size="md"
          />
        </SettingRow>
      </SettingsSection>

      {enabled && (
        <SettingsSection
          id="settings-section-sync-server"
          title={t("settings.sync.server_section")}
          icon="solar:server-bold"
          keywords={kw("settings.sync.server_section", "server", "url", "api", "key", "token")}
          description={t("settings.sync.server.description")}
        >
          <div className="space-y-4 py-2">
            <div>
              <label className="block text-sm font-smallcaps text-white/70 mb-2">
                {t("settings.sync.url")}
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) =>
                  tempConfig &&
                  setTempConfig({ ...tempConfig, sync_api_url: e.target.value || null })
                }
                placeholder={t("settings.sync.url.placeholder")}
                className="w-full p-3 rounded-md bg-black/40 border border-[#ffffff20] text-white placeholder-white/40 font-minecraft focus:outline-none focus:ring-2 focus:ring-white/30"
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <div>
              <label className="block text-sm font-smallcaps text-white/70 mb-2">
                {t("settings.sync.api_key")}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) =>
                  tempConfig &&
                  setTempConfig({ ...tempConfig, sync_api_key: e.target.value || null })
                }
                placeholder={t("settings.sync.api_key.placeholder")}
                className="w-full p-3 rounded-md bg-black/40 border border-[#ffffff20] text-white placeholder-white/40 font-minecraft focus:outline-none focus:ring-2 focus:ring-white/30"
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTest}
                disabled={testing || saving || !url.trim()}
                icon={
                  <Icon
                    icon={testing ? "svg-spinners:ring-resize" : "solar:plug-circle-bold"}
                    className="w-5 h-5"
                  />
                }
              >
                {testing ? t("settings.sync.testing") : t("settings.sync.test")}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleSyncNow}
                disabled={status.running || saving || !savedEnabled}
                icon={
                  <Icon
                    icon={status.running ? "svg-spinners:ring-resize" : "solar:refresh-bold"}
                    className="w-5 h-5"
                  />
                }
              >
                {t("settings.sync.sync_now")}
              </Button>

              {testResult && (
                <span
                  className={`text-sm font-minecraft ${testResult.ok ? "text-emerald-300" : "text-rose-300"}`}
                >
                  {testResult.ok
                    ? t("settings.sync.test_ok", {
                        name: testResult.name ?? "server",
                        version: testResult.version ?? "",
                      })
                    : t("settings.sync.test_failed", { error: testResult.error ?? "" })}
                </span>
              )}
            </div>

            {status.running && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between gap-2 text-xs font-minecraft text-white/60">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {status.current ? (
                      <>
                        <Icon
                          icon={
                            status.current.direction === "up"
                              ? "solar:upload-minimalistic-bold"
                              : "solar:download-minimalistic-bold"
                          }
                          className="w-3.5 h-3.5 flex-shrink-0"
                        />
                        <span className="truncate">{status.current.path}</span>
                      </>
                    ) : (
                      <span className="truncate">
                        {status.message ?? t("sync.dropdown.working")}
                      </span>
                    )}
                  </span>
                  {status.total > 0 && (
                    <span className="tabular-nums flex-shrink-0">
                      {status.processed}/{status.total}
                    </span>
                  )}
                </div>
                <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{
                      width:
                        status.total > 0
                          ? `${Math.round((status.processed / status.total) * 100)}%`
                          : "100%",
                      backgroundColor: accentColor.value,
                      opacity: status.total > 0 ? 1 : 0.4,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="mt-4 p-4 rounded-lg border border-[#ffffff20] bg-black/10">
              <div className="flex items-start gap-3">
                <Icon icon="solar:info-circle-bold" className="w-6 h-6 text-blue-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-smallcaps text-blue-300 mb-1">
                    {t("settings.sync.info.title")}
                  </h4>
                  <p className="text-sm text-blue-200/80 font-minecraft">
                    {t("settings.sync.info.body")}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePullAll}
                disabled={status.running || saving || !savedEnabled}
                icon={<Icon icon="solar:cloud-download-bold" className="w-5 h-5" />}
              >
                {t("settings.sync.pull_all.button")}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadRemote}
                disabled={loadingRemote || status.running || saving || !savedEnabled}
                icon={
                  <Icon
                    icon={loadingRemote ? "svg-spinners:ring-resize" : "solar:list-check-bold"}
                    className="w-5 h-5"
                  />
                }
              >
                {remoteProfiles
                  ? t("settings.sync.select.refresh")
                  : t("settings.sync.select.load")}
              </Button>
            </div>

            {remoteProfiles && (
              <div className="mt-2 rounded-lg border border-[#ffffff20] bg-black/10">
                <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#ffffff14]">
                  <div className="min-w-0">
                    <h4 className="text-sm font-smallcaps text-white/80">
                      {t("settings.sync.select.title")}
                    </h4>
                    <p className="text-xs text-white/50 font-minecraft truncate">
                      {t("settings.sync.select.description")}
                    </p>
                  </div>
                  {remoteProfiles.length > 0 && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={selectAllRemote}
                        className="text-xs font-minecraft text-white/60 hover:text-white/90 transition-colors"
                      >
                        {t("settings.sync.select.select_all")}
                      </button>
                      <span className="text-white/20">·</span>
                      <button
                        type="button"
                        onClick={selectNoneRemote}
                        className="text-xs font-minecraft text-white/60 hover:text-white/90 transition-colors"
                      >
                        {t("settings.sync.select.select_none")}
                      </button>
                    </div>
                  )}
                </div>

                {remoteProfiles.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-white/50 font-minecraft text-center">
                    {t("settings.sync.select.empty")}
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto p-2 space-y-1">
                    {remoteProfiles.map((profile) => {
                      const checked = selectedIds.has(profile.id);
                      const meta = [
                        profile.game_version ?? undefined,
                        profile.loader ?? undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <label
                          key={profile.id}
                          className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer hover:bg-white/5 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleProfile(profile.id)}
                            disabled={status.running}
                            className="w-4 h-4 flex-shrink-0 accent-current"
                            style={{ accentColor: accentColor.value }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-minecraft text-white/90 truncate">
                                {profile.name}
                              </span>
                              {profile.group && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-minecraft text-white/60 bg-white/10 flex-shrink-0">
                                  {profile.group}
                                </span>
                              )}
                              {profile.already_local && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-minecraft text-emerald-300/90 bg-emerald-500/15 flex-shrink-0">
                                  {t("settings.sync.select.already_local")}
                                </span>
                              )}
                            </div>
                            {meta && (
                              <span className="text-xs text-white/45 font-minecraft">{meta}</span>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}

                {remoteProfiles.length > 0 && (
                  <div className="px-4 py-3 border-t border-[#ffffff14]">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handlePullSelected}
                      disabled={status.running || saving || selectedIds.size === 0}
                      icon={<Icon icon="solar:cloud-download-bold" className="w-5 h-5" />}
                    >
                      {t("settings.sync.select.download", { count: selectedIds.size })}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {status.storage_full && (
              <div className="p-4 rounded-lg border border-orange-500/30 bg-orange-900/20">
                <div className="flex items-start gap-3">
                  <Icon icon="solar:danger-triangle-bold" className="w-6 h-6 text-orange-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-orange-200/80 font-minecraft">
                    {t("settings.sync.storage_full")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </SettingsSection>
      )}

      {confirmDialog}
    </div>
  );
}
