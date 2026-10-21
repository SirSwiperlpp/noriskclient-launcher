"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import type { Profile } from "../../../types/profile";
import { useModPresetsStore } from "../../../store/useModPresetsStore";
import {
  applyPresetToProfile,
  type ApplyPresetResult,
} from "../../../utils/mod-presets";

interface ModProfilePresetModalProps {
  open: boolean;
  onClose: () => void;
  targetProfile: Profile | null;
  onApplied?: () => void;
}

export function ModProfilePresetModal({
  open,
  onClose,
  targetProfile,
  onApplied,
}: ModProfilePresetModalProps) {
  const { t } = useTranslation();
  const presets = useModPresetsStore((s) => s.presets);
  const deletePreset = useModPresetsStore((s) => s.deletePreset);

  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summaries, setSummaries] = useState<Record<string, ApplyPresetResult>>({});

  if (!open) return null;

  const handleApply = async (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset || !targetProfile || applyingId) return;

    setApplyingId(preset.id);
    setProgress({ done: 0, total: preset.items.length });
    setSummaries((prev) => {
      const next = { ...prev };
      delete next[preset.id];
      return next;
    });

    try {
      const res = await applyPresetToProfile(preset, targetProfile, (p) =>
        setProgress({ done: p.done, total: p.total }),
      );
      setSummaries((prev) => ({ ...prev, [preset.id]: res }));
      onApplied?.();
    } catch (e) {
      console.error("[ModProfilePresetModal] apply failed:", e);
    } finally {
      setApplyingId(null);
      setProgress(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={applyingId ? undefined : onClose}
      />

      {/* Card */}
      <div className="relative z-10 w-[32rem] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl border border-white/15 bg-neutral-900/95 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Icon icon="solar:folder-with-files-bold" className="w-5 h-5 text-white/80" />
            <h2 className="font-smallcaps text-lg text-white">{t("modProfile.title")}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={!!applyingId}
            className="text-white/60 hover:text-white disabled:opacity-40 transition-colors"
            aria-label={t("common.close")}
          >
            <Icon icon="solar:close-circle-bold" className="w-6 h-6" />
          </button>
        </div>

        {/* Target */}
        <div className="px-5 py-3 border-b border-white/10 text-sm">
          {targetProfile ? (
            <span className="text-white/70">
              {t("modProfile.target")}:{" "}
              <span className="text-white font-medium">{targetProfile.name}</span>
              <span className="text-white/40"> · {targetProfile.game_version}</span>
            </span>
          ) : (
            <span className="text-amber-300/90">{t("modProfile.noTarget")}</span>
          )}
        </div>

        {/* Preset list */}
        <div className="flex-1 overflow-y-auto p-3">
          {presets.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-white/55">
              {t("modProfile.empty")}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((preset) => {
                const isApplying = applyingId === preset.id;
                const summary = summaries[preset.id];
                return (
                  <li
                    key={preset.id}
                    className="rounded-lg border border-white/10 bg-black/30 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-medium truncate">{preset.name}</div>
                        <div className="text-xs text-white/45">
                          {t("modProfile.items", { count: preset.items.length })}
                        </div>
                      </div>

                      <button
                        onClick={() => handleApply(preset.id)}
                        disabled={!targetProfile || !!applyingId || preset.items.length === 0}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-smallcaps transition-colors",
                          "bg-green-500/80 hover:bg-green-500 text-white disabled:opacity-40 disabled:hover:bg-green-500/80",
                        )}
                      >
                        <Icon
                          icon={isApplying ? "solar:refresh-bold" : "solar:download-minimalistic-bold"}
                          className={cn("w-4 h-4", isApplying && "animate-spin")}
                        />
                        {isApplying && progress
                          ? t("modProfile.applying", { done: progress.done, total: progress.total })
                          : t("modProfile.apply")}
                      </button>

                      <button
                        onClick={() => deletePreset(preset.id)}
                        disabled={!!applyingId}
                        className="text-white/40 hover:text-red-400 disabled:opacity-30 transition-colors"
                        title={t("modProfile.delete")}
                      >
                        <Icon icon="solar:trash-bin-trash-bold" className="w-5 h-5" />
                      </button>
                    </div>

                    {summary && (
                      <div className="mt-2 text-xs text-white/60">
                        {t("modProfile.summary", {
                          installed: summary.installed,
                          skipped: summary.skipped,
                          failed: summary.failed,
                        })}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
