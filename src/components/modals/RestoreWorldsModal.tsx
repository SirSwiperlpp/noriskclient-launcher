"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@iconify/react";
import { toast } from "react-hot-toast";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/buttons/Button";
import { timeAgo } from "../../utils/time-utils";
import { parseErrorMessage } from "../../utils/error-utils";
import {
  listWorldBackups,
  restoreWorldBackup,
  type WorldBackupInfo,
} from "../../services/sync-service";

interface RestoreWorldsModalProps {
  profileId: string;
  onClose: () => void;
  onRestored?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function RestoreWorldsModal({ profileId, onClose, onRestored }: RestoreWorldsModalProps) {
  const { t } = useTranslation();
  const [backups, setBackups] = useState<WorldBackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listWorldBackups(profileId);
      setBackups(list);
    } catch (err) {
      setError(parseErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = async (backup: WorldBackupInfo) => {
    setRestoringId(`${backup.world}:${backup.id}`);
    try {
      await toast.promise(restoreWorldBackup(profileId, backup.world, backup.id), {
        loading: t("worlds.restore.restoring", { world: backup.world }),
        success: t("worlds.restore.restore_success", { world: backup.world }),
        error: (err) => t("worlds.restore.restore_failed", { error: parseErrorMessage(err) }),
      });
      onRestored?.();
    } catch {
      // handled by toast
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <Modal
      title={t("worlds.restore_title")}
      titleIcon={<Icon icon="solar:history-bold" className="w-7 h-7" />}
      onClose={onClose}
      width="md"
    >
      <div className="p-4 min-h-[200px]">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-white/50 font-minecraft text-sm">
            <Icon icon="svg-spinners:ring-resize" className="w-5 h-5 mr-2" />
            {t("worlds.restore.loading")}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-40 gap-3">
            <div className="flex items-center gap-2 text-rose-300 font-minecraft text-sm">
              <Icon icon="solar:danger-triangle-bold" className="w-5 h-5" />
              {t("worlds.restore.failed", { error })}
            </div>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("worlds.restore.retry")}
            </Button>
          </div>
        ) : backups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center">
            <Icon icon="solar:cloud-cross-bold" className="w-10 h-10 text-white/30 mb-3" />
            <p className="text-white/60 font-smallcaps text-sm">{t("worlds.restore.empty")}</p>
            <p className="text-white/40 font-minecraft text-xs mt-1">{t("worlds.restore.empty_hint")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[55vh] overflow-y-auto custom-scrollbar">
            {backups.map((backup) => {
              const rowId = `${backup.world}:${backup.id}`;
              const isRestoring = restoringId === rowId;
              return (
                <div
                  key={rowId}
                  className="flex items-center gap-3 p-3 rounded-lg border border-white/10 bg-white/[0.03]"
                >
                  <div className="w-10 h-10 rounded-md bg-white/10 flex items-center justify-center flex-shrink-0">
                    <Icon icon="solar:planet-bold-duotone" className="w-5 h-5 text-white/50" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-minecraft truncate" title={backup.world}>
                      {backup.world}
                    </div>
                    <div className="text-xs text-white/50 font-minecraft">
                      {t("worlds.restore.created", { time: timeAgo(backup.created_at) })} · {formatBytes(backup.size)}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRestore(backup)}
                    disabled={restoringId !== null}
                    icon={
                      <Icon
                        icon={isRestoring ? "svg-spinners:ring-resize" : "solar:download-bold"}
                        className="w-4 h-4"
                      />
                    }
                  >
                    {t("worlds.restore.restore_button")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
