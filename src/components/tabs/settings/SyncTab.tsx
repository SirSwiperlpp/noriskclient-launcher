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
import {
  testSyncConnection,
  refreshSync,
  syncNow,
  type SyncConnectionResult,
} from "../../../services/sync-service";
import { useSyncStore } from "../../../store/sync-store";
import { parseErrorMessage } from "../../../utils/error-utils";

export function SyncTab() {
  const { t } = useTranslation();
  const kw = useSettingsKeywords();
  const { config, tempConfig, setTempConfig, saving } = useSettingsConfig();
  const status = useSyncStore((s) => s.status);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SyncConnectionResult | null>(null);

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
    </div>
  );
}
