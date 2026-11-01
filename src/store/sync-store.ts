import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  getSyncStatus,
  syncNow,
  SYNC_STATUS_EVENT,
  type SyncStatus,
} from "../services/sync-service";
import { getRunningProcesses } from "../services/process-service";
import { useProfileStore } from "./profile-store";

const DEFAULT_STATUS: SyncStatus = {
  enabled: false,
  phase: "disabled",
  running: false,
  message: null,
  error: null,
  storage_full: false,
  processed: 0,
  total: 0,
  uploaded: 0,
  downloaded: 0,
  current: null,
  last_synced_ms: null,
};

interface SyncStoreState {
  status: SyncStatus;
  initialized: boolean;
  setStatus: (status: SyncStatus) => void;
  init: () => Promise<void>;
}

let unlisten: (() => void) | null = null;

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  status: DEFAULT_STATUS,
  initialized: false,
  setStatus: (status) => set({ status }),
  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });

    try {
      set({ status: await getSyncStatus() });
    } catch (err) {
      console.error("[sync] failed to load initial status:", err);
    }

    if (!unlisten) {
      try {
        unlisten = await listen<SyncStatus>(SYNC_STATUS_EVENT, (event) => {
          const previousPhase = get().status.phase;
          set({ status: event.payload });
          if (event.payload.phase === "done" && previousPhase !== "done") {
            void useProfileStore.getState().fetchProfiles().catch(() => undefined);
          }
        });
      } catch (err) {
        console.error("[sync] failed to subscribe to status events:", err);
      }
    }

    if (get().status.enabled) {
      window.setTimeout(() => {
        void syncNow().catch(() => undefined);
      }, 3000);
    }

    let previousRunning = 0;
    window.setInterval(async () => {
      try {
        const running = (await getRunningProcesses()).length;
        const current = get().status;
        if (previousRunning > 0 && running === 0 && current.enabled && !current.running) {
          void syncNow().catch(() => undefined);
        }
        previousRunning = running;
      } catch {
        // ignore polling errors
      }
    }, 10000);
  },
}));
