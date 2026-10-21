import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ModPlatform } from "../types/unified";

// A saved "Mod Profile" preset: a named snapshot of a profile's installed
// Modrinth/CurseForge content (mods + resource packs + shaders). Applying a
// preset re-resolves the newest compatible version for the target profile's
// Minecraft version + loader and installs each item. Stored locally per device.

export type ModPresetContentKind = "mod" | "resourcepack" | "shader";

export interface ModPresetItem {
  source: ModPlatform; // Modrinth | CurseForge
  kind: ModPresetContentKind;
  projectId: string;
  name: string;
}

export interface ModPreset {
  id: string;
  name: string;
  createdAt: string; // ISO timestamp
  items: ModPresetItem[];
}

interface ModPresetsState {
  presets: ModPreset[];
  addPreset: (name: string, items: ModPresetItem[]) => ModPreset;
  deletePreset: (id: string) => void;
  renamePreset: (id: string, name: string) => void;
}

const STORAGE_KEY = "norisk-mod-presets";

function genId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export const useModPresetsStore = create<ModPresetsState>()(
  persist(
    (set) => ({
      presets: [],

      addPreset: (name, items) => {
        const preset: ModPreset = {
          id: genId(),
          name: name.trim() || "Preset",
          createdAt: new Date().toISOString(),
          items,
        };
        set((state) => ({ presets: [preset, ...state.presets] }));
        return preset;
      },

      deletePreset: (id) => {
        set((state) => ({ presets: state.presets.filter((p) => p.id !== id) }));
      },

      renamePreset: (id, name) => {
        set((state) => ({
          presets: state.presets.map((p) =>
            p.id === id ? { ...p, name: name.trim() || p.name } : p,
          ),
        }));
      },
    }),
    {
      name: STORAGE_KEY,
      onRehydrateStorage: () => (state) => {
        if (state && !Array.isArray(state.presets)) {
          state.presets = [];
        }
      },
    },
  ),
);
