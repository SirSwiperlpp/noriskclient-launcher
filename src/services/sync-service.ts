import { invoke } from "@tauri-apps/api/core";

export type SyncPhase = "idle" | "running" | "error" | "done" | "disabled";
export type SyncDirection = "up" | "down";

export interface SyncFileActivity {
  profile_id: string;
  profile_name: string;
  path: string;
  direction: SyncDirection;
}

export interface SyncStatus {
  enabled: boolean;
  phase: SyncPhase;
  running: boolean;
  message: string | null;
  error: string | null;
  storage_full: boolean;
  processed: number;
  total: number;
  uploaded: number;
  downloaded: number;
  current: SyncFileActivity | null;
  last_synced_ms: number | null;
}

export interface SyncConnectionResult {
  ok: boolean;
  name: string | null;
  version: string | null;
  error: string | null;
}

export interface WorldBackupInfo {
  world: string;
  id: string;
  size: number;
  created_at: number;
}

export interface RemoteProfileSummary {
  id: string;
  name: string;
  game_version: string | null;
  loader: string | null;
  group: string | null;
  already_local: boolean;
}

export const SYNC_STATUS_EVENT = "cloud_sync_status";

export async function getSyncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_get_status");
}

export async function isSyncRunning(): Promise<boolean> {
  return invoke<boolean>("sync_is_running");
}

export async function syncNow(): Promise<void> {
  await invoke("sync_now");
}

export async function pullAllProfiles(): Promise<void> {
  await invoke("sync_pull_all");
}

export async function listRemoteProfiles(): Promise<RemoteProfileSummary[]> {
  return invoke<RemoteProfileSummary[]>("sync_list_remote_profiles");
}

export async function pullSelectedProfiles(profileIds: string[]): Promise<void> {
  await invoke("sync_pull_selected", { profileIds });
}

export async function refreshSync(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_refresh");
}

export async function testSyncConnection(
  url: string,
  apiKey: string | null,
): Promise<SyncConnectionResult> {
  return invoke<SyncConnectionResult>("sync_test_connection", { url, apiKey });
}

export async function listWorldBackups(
  profileId: string,
): Promise<WorldBackupInfo[]> {
  return invoke<WorldBackupInfo[]>("sync_list_world_backups", { profileId });
}

export async function restoreWorldBackup(
  profileId: string,
  world: string,
  backupId: string,
): Promise<void> {
  await invoke("sync_restore_world_backup", { profileId, world, backupId });
}
