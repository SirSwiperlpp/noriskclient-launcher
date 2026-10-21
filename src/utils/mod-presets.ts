import { ModPlatform } from "../types/unified";
import type { UnifiedVersion } from "../types/unified";
import { ContentType } from "../types/content";
import type { InstallContentPayload } from "../types/content";
import type { Profile } from "../types/profile";
import UnifiedService from "../services/unified-service";
import { installContentToProfile } from "../services/content-service";
import * as ProfileService from "../services/profile-service";
import type {
  ModPreset,
  ModPresetItem,
  ModPresetContentKind,
} from "../store/useModPresetsStore";

/**
 * Collects a profile's installed Modrinth/CurseForge content (mods + resource
 * packs + shaders) into preset items. Local/custom items without a known source
 * project are skipped (they can't be re-installed from a preset).
 */
export async function buildPresetItemsFromProfile(
  profileId: string,
): Promise<ModPresetItem[]> {
  const items: ModPresetItem[] = [];
  const seen = new Set<string>();

  const push = (
    source: ModPlatform,
    kind: ModPresetContentKind,
    projectId: string | null | undefined,
    name: string | null | undefined,
  ) => {
    if (!projectId) return;
    const key = `${source}:${kind}:${projectId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ source, kind, projectId: String(projectId), name: name || String(projectId) });
  };

  // Mods come from the full profile object.
  try {
    const profile = await ProfileService.getProfile(profileId);
    for (const mod of profile.mods || []) {
      const src = mod.source;
      if (src?.type === "modrinth") {
        push(ModPlatform.Modrinth, "mod", src.project_id, mod.display_name);
      } else if (src?.type === "curseforge") {
        push(ModPlatform.CurseForge, "mod", src.project_id, mod.display_name);
      }
    }
  } catch (e) {
    console.error("[mod-presets] Failed to read mods for preset:", e);
  }

  // Resource packs.
  try {
    const packs = await ProfileService.getLocalResourcepacks(profileId);
    for (const p of packs) {
      if (p.modrinth_info) {
        push(ModPlatform.Modrinth, "resourcepack", p.modrinth_info.project_id, p.modrinth_info.name ?? p.filename);
      } else if (p.curseforge_info) {
        push(ModPlatform.CurseForge, "resourcepack", p.curseforge_info.project_id, p.curseforge_info.name ?? p.filename);
      }
    }
  } catch (e) {
    console.error("[mod-presets] Failed to read resource packs for preset:", e);
  }

  // Shaders.
  try {
    const shaders = await ProfileService.getLocalShaderpacks(profileId);
    for (const s of shaders) {
      if (s.modrinth_info) {
        push(ModPlatform.Modrinth, "shader", s.modrinth_info.project_id, s.modrinth_info.name ?? s.filename);
      } else if (s.curseforge_info) {
        push(ModPlatform.CurseForge, "shader", s.curseforge_info.project_id, s.curseforge_info.name ?? s.filename);
      }
    }
  } catch (e) {
    console.error("[mod-presets] Failed to read shaders for preset:", e);
  }

  return items;
}

function contentTypeForKind(kind: ModPresetContentKind): ContentType {
  switch (kind) {
    case "mod":
      return ContentType.Mod;
    case "resourcepack":
      return ContentType.ResourcePack;
    case "shader":
      return ContentType.ShaderPack;
  }
}

export interface ApplyPresetProgress {
  total: number;
  done: number;
  currentName: string;
}

export interface ApplyPresetResult {
  installed: number;
  skipped: number;
  failed: number;
  skippedNames: string[];
  failedNames: string[];
}

/**
 * Installs every item of a preset into the target profile, resolving the newest
 * compatible version for the profile's Minecraft version + loader. Items with no
 * compatible version are skipped; install errors are counted as failures. Works
 * for both Modrinth and CurseForge via the unified install command.
 */
export async function applyPresetToProfile(
  preset: ModPreset,
  profile: Profile,
  onProgress?: (p: ApplyPresetProgress) => void,
): Promise<ApplyPresetResult> {
  const result: ApplyPresetResult = {
    installed: 0,
    skipped: 0,
    failed: 0,
    skippedNames: [],
    failedNames: [],
  };

  const total = preset.items.length;
  let done = 0;

  for (const item of preset.items) {
    onProgress?.({ total, done, currentName: item.name });
    try {
      // Mods must match the profile's loader; resource packs / shaders are
      // loader-independent, so we only constrain by game version for those.
      const loaders = item.kind === "mod" && profile.loader ? [profile.loader] : undefined;

      const resp = await UnifiedService.getModVersions({
        source: item.source,
        project_id: item.projectId,
        loaders,
        game_versions: profile.game_version ? [profile.game_version] : undefined,
        limit: 30,
      });

      const version: UnifiedVersion | undefined = resp.versions?.[0];
      const file = version?.files?.find((f) => f.primary) ?? version?.files?.[0];

      if (!version || !file) {
        result.skipped++;
        result.skippedNames.push(item.name);
        done++;
        continue;
      }

      const payload: InstallContentPayload = {
        profile_id: profile.id,
        project_id: item.projectId,
        version_id: version.id,
        file_name: file.filename,
        download_url: file.url,
        file_hash_sha1: file.hashes?.sha1,
        file_fingerprint: file.fingerprint,
        content_name: item.name,
        version_number: version.version_number,
        content_type: contentTypeForKind(item.kind),
        loaders: version.loaders,
        game_versions: version.game_versions,
        source: item.source,
      };

      await installContentToProfile(payload);
      result.installed++;
    } catch (e) {
      console.error(`[mod-presets] Failed to install "${item.name}":`, e);
      result.failed++;
      result.failedNames.push(item.name);
    }
    done++;
  }

  onProgress?.({ total, done, currentName: "" });
  return result;
}
