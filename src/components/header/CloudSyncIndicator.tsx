"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@iconify/react";
import { toast } from "react-hot-toast";
import { cn } from "../../lib/utils";
import { Button } from "../ui/buttons/Button";
import { Dropdown } from "../ui/dropdown/Dropdown";
import { DropdownHeader } from "../ui/dropdown/DropdownHeader";
import { DropdownFooter } from "../ui/dropdown/DropdownFooter";
import { timeAgo } from "../../utils/time-utils";
import { parseErrorMessage } from "../../utils/error-utils";
import { useSyncStore } from "../../store/sync-store";
import { syncNow } from "../../services/sync-service";

interface CloudSyncIndicatorProps {
  className?: string;
}

export function CloudSyncIndicator({ className }: CloudSyncIndicatorProps) {
  const { t } = useTranslation();
  const status = useSyncStore((s) => s.status);
  const init = useSyncStore((s) => s.init);
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    init();
  }, [init]);

  if (!status.enabled) return null;

  const isError = status.phase === "error" || status.storage_full;
  const isRunning = status.running;

  const buttonVariant = isError ? "destructive" : isRunning ? "secondary" : "flat";
  const buttonIcon = isRunning
    ? "svg-spinners:ring-resize"
    : isError
      ? "solar:cloud-cross-bold"
      : "solar:cloud-check-bold";

  const buttonLabel = isRunning
    ? t("sync.bar.syncing")
    : isError
      ? t("sync.bar.error")
      : t("sync.bar.synced");

  const handleSyncNow = async () => {
    try {
      await syncNow();
      toast.success(t("settings.sync.sync_started"));
    } catch (err) {
      toast.error(parseErrorMessage(err));
    }
  };

  const directionLabel = (direction: "up" | "down") =>
    direction === "up" ? t("sync.dropdown.up") : t("sync.dropdown.down");

  return (
    <div className={cn("relative", className)}>
      <div ref={buttonRef} className="relative">
        <Button
          variant={buttonVariant}
          size="sm"
          onClick={() => setIsOpen((v) => !v)}
          icon={<Icon icon={buttonIcon} className="w-4 h-4" />}
          className="h-10"
        >
          {buttonLabel}
        </Button>
      </div>

      <Dropdown
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        triggerRef={buttonRef}
        width={340}
      >
        <DropdownHeader title={t("sync.dropdown.title")}>
          <button
            onClick={() => setIsOpen(false)}
            className="text-white/70 hover:text-white transition-colors"
          >
            <Icon icon="solar:close-circle-bold" className="w-5 h-5" />
          </button>
        </DropdownHeader>

        <div className="p-4 space-y-3">
          {status.storage_full && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-orange-500/30 bg-orange-900/20">
              <Icon icon="solar:danger-triangle-bold" className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-orange-200/90 font-smallcaps">
                {t("sync.dropdown.storage_full")}
              </p>
            </div>
          )}

          {status.phase === "error" && !status.storage_full && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-rose-400/30 bg-rose-500/10">
              <Icon icon="solar:danger-triangle-bold" className="w-5 h-5 text-rose-300 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-rose-200/90 font-smallcaps break-words">
                {status.error ?? t("sync.dropdown.error")}
              </p>
            </div>
          )}

          {isRunning && status.current ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon
                  icon={
                    status.current.direction === "up"
                      ? "solar:upload-minimalistic-bold"
                      : "solar:download-minimalistic-bold"
                  }
                  className={cn(
                    "w-4 h-4 flex-shrink-0",
                    status.current.direction === "up" ? "text-sky-300" : "text-emerald-300",
                  )}
                />
                <span className="text-xs text-white/60 font-smallcaps">
                  {directionLabel(status.current.direction)}
                </span>
              </div>
              <div className="text-sm text-white font-minecraft truncate" title={status.current.path}>
                {status.current.path}
              </div>
              <div className="text-xs text-white/50 font-minecraft truncate">
                {status.current.profile_name}
              </div>
              <div className="text-xs text-white/60 font-smallcaps">
                {t("sync.dropdown.progress", {
                  processed: status.processed,
                  total: status.total,
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-white/70 font-smallcaps">
              <Icon icon="solar:check-circle-bold" className="w-4 h-4 text-emerald-400" />
              {t("sync.dropdown.idle")}
            </div>
          )}

          <div className="flex items-center gap-4 pt-1 text-xs font-minecraft">
            <span className="inline-flex items-center gap-1 text-sky-300">
              <Icon icon="solar:upload-minimalistic-bold" className="w-3.5 h-3.5" />
              {t("sync.dropdown.uploaded", { count: status.uploaded })}
            </span>
            <span className="inline-flex items-center gap-1 text-emerald-300">
              <Icon icon="solar:download-minimalistic-bold" className="w-3.5 h-3.5" />
              {t("sync.dropdown.downloaded", { count: status.downloaded })}
            </span>
          </div>

          <div className="text-xs text-white/40 font-smallcaps">
            {status.last_synced_ms
              ? t("sync.dropdown.last_synced", { time: timeAgo(status.last_synced_ms) })
              : t("sync.dropdown.never")}
          </div>
        </div>

        <DropdownFooter>
          <div className="flex items-center justify-end w-full">
            <Button
              variant="flat"
              size="xs"
              onClick={handleSyncNow}
              disabled={isRunning}
              icon={
                <Icon
                  icon={isRunning ? "svg-spinners:ring-resize" : "solar:refresh-bold"}
                  className="w-4 h-4"
                />
              }
            >
              {t("sync.dropdown.sync_now")}
            </Button>
          </div>
        </DropdownFooter>
      </Dropdown>
    </div>
  );
}
