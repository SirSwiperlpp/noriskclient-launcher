use super::client::{RemoteEntry, RemoteWorldBackup, SyncClient, WriteResult};
use super::{now_ms, CloudSyncManager, SyncDirection, SyncFailure, SyncFileActivity, SyncReport};
use crate::config::{ProjectDirsExt, LAUNCHER_DIRECTORY};
use crate::error::{AppError, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::fs;
use uuid::Uuid;

const SYNC_DIR_ROOTS: [&str; 5] = ["saves", "mods", "resourcepacks", "shaderpacks", "config"];
const SYNC_FILE_ROOTS: [&str; 2] = ["options.txt", "servers.dat"];
const LOCAL_BACKUP_RETENTION_MS: i64 = 14 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct SyncConnectionResult {
    pub ok: bool,
    pub name: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalEntry {
    hash: String,
    mtime: i64,
}

struct PlanItem {
    rel: String,
    direction: SyncDirection,
}

struct ProfilePlan {
    id: Uuid,
    name: String,
    instance_dir: PathBuf,
    local: HashMap<String, LocalEntry>,
    items: Vec<PlanItem>,
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

fn is_safe_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') {
            return false;
        }
    }
    true
}

fn resolve(instance_dir: &Path, rel: &str) -> PathBuf {
    let mut path = instance_dir.to_path_buf();
    for seg in rel.split('/') {
        path.push(seg);
    }
    path
}

fn world_of(rel: &str) -> Option<String> {
    let mut parts = rel.split('/');
    if parts.next() == Some("saves") {
        if let Some(world) = parts.next() {
            if !world.is_empty() {
                return Some(world.to_string());
            }
        }
    }
    None
}

fn worlds_in(items: &[PlanItem], direction: SyncDirection) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for item in items {
        if item.direction == direction {
            if let Some(world) = world_of(&item.rel) {
                set.insert(world);
            }
        }
    }
    set.into_iter().collect()
}

async fn hash_entry(path: &Path, meta: &std::fs::Metadata) -> Result<LocalEntry> {
    let bytes = fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(LocalEntry {
        hash: hex_encode(&hasher.finalize()),
        mtime: mtime_ms(meta),
    })
}

async fn walk_dir(root: &Path, prefix: &str, out: &mut HashMap<String, LocalEntry>) -> Result<()> {
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), prefix.to_string())];
    while let Some((dir, rel_prefix)) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = format!("{}/{}", rel_prefix, name);
            let meta = match fs::metadata(&path).await {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push((path, rel));
            } else if meta.is_file() {
                if let Ok(entry) = hash_entry(&path, &meta).await {
                    out.insert(rel, entry);
                }
            }
        }
    }
    Ok(())
}

async fn build_local_manifest(instance_dir: &Path) -> Result<HashMap<String, LocalEntry>> {
    let mut out = HashMap::new();
    for root in SYNC_DIR_ROOTS {
        let dir = instance_dir.join(root);
        if fs::metadata(&dir).await.map(|m| m.is_dir()).unwrap_or(false) {
            walk_dir(&dir, root, &mut out).await?;
        }
    }
    for file in SYNC_FILE_ROOTS {
        let path = instance_dir.join(file);
        if let Ok(meta) = fs::metadata(&path).await {
            if meta.is_file() {
                if let Ok(entry) = hash_entry(&path, &meta).await {
                    out.insert(file.to_string(), entry);
                }
            }
        }
    }
    Ok(out)
}

fn diff(local: &HashMap<String, LocalEntry>, remote: &HashMap<String, RemoteEntry>) -> Vec<PlanItem> {
    let mut keys: HashSet<&String> = HashSet::new();
    keys.extend(local.keys());
    keys.extend(remote.keys());

    let mut items = Vec::new();
    for key in keys {
        if !is_safe_rel(key) {
            continue;
        }
        match (local.get(key), remote.get(key)) {
            (Some(_), None) => items.push(PlanItem {
                rel: key.clone(),
                direction: SyncDirection::Up,
            }),
            (None, Some(_)) => items.push(PlanItem {
                rel: key.clone(),
                direction: SyncDirection::Down,
            }),
            (Some(local_entry), Some(remote_entry)) => {
                if local_entry.hash == remote_entry.hash {
                    continue;
                }
                let direction = if local_entry.mtime >= remote_entry.mtime {
                    SyncDirection::Up
                } else {
                    SyncDirection::Down
                };
                items.push(PlanItem {
                    rel: key.clone(),
                    direction,
                });
            }
            (None, None) => {}
        }
    }
    items.sort_by(|a, b| a.rel.cmp(&b.rel));
    items
}

async fn write_atomic(abs: &Path, bytes: &[u8]) -> Result<()> {
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::Other("Invalid target path".to_string()))?;
    fs::create_dir_all(parent).await?;
    let file_name = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = parent.join(format!(".{}.tmp-{}", file_name, Uuid::new_v4().simple()));
    fs::write(&tmp, bytes).await?;
    fs::rename(&tmp, abs).await?;
    Ok(())
}

fn local_backup_root() -> PathBuf {
    LAUNCHER_DIRECTORY
        .meta_dir()
        .join("cloud_sync_local_backups")
}

async fn copy_dir(src: &Path, dest: &Path) -> Result<()> {
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), dest.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        fs::create_dir_all(&to).await?;
        let mut entries = match fs::read_dir(&from).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let target = to.join(&name);
            let meta = match fs::metadata(&path).await {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push((path, target));
            } else if meta.is_file() {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).await?;
                }
                let _ = fs::copy(&path, &target).await?;
            }
        }
    }
    Ok(())
}

async fn prune_local_backups(dir: &Path) -> Result<()> {
    let cutoff = now_ms() - LOCAL_BACKUP_RETENTION_MS;
    let mut entries = match fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(ts) = name.parse::<i64>() {
            if ts < cutoff {
                let _ = fs::remove_dir_all(entry.path()).await;
            }
        }
    }
    Ok(())
}

async fn local_world_backup(profile_id: &Uuid, world: &str, world_dir: &Path) -> Result<()> {
    let root = local_backup_root().join(profile_id.to_string()).join(world);
    fs::create_dir_all(&root).await?;
    let dest = root.join(now_ms().to_string());
    copy_dir(world_dir, &dest).await?;
    let _ = prune_local_backups(&root).await;
    Ok(())
}

async fn extract_zip_into(bytes: Vec<u8>, dest: &Path) -> Result<()> {
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let reader = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|e| AppError::Other(format!("Failed to open backup zip: {}", e)))?;
        std::fs::create_dir_all(&dest)?;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| AppError::Other(format!("Failed to read backup entry: {}", e)))?;
            let raw = entry.name().replace('\\', "/");
            let mut safe = PathBuf::new();
            let mut ok = true;
            for seg in raw.split('/') {
                if seg.is_empty() || seg == "." {
                    continue;
                }
                if seg == ".." {
                    ok = false;
                    break;
                }
                safe.push(seg);
            }
            if !ok {
                continue;
            }
            let out_path = dest.join(&safe);
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut out = std::fs::File::create(&out_path)?;
                std::io::copy(&mut entry, &mut out)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("Backup extraction task failed: {}", e)))?
}

async fn client_from_config() -> Result<SyncClient> {
    let state = crate::state::State::get().await?;
    let config = state.config_manager.get_config().await;
    if !config.sync_enabled {
        return Err(AppError::Other("Cloud sync is disabled".to_string()));
    }
    let url = config.sync_api_url.unwrap_or_default();
    SyncClient::new(&url, config.sync_api_key)
}

pub async fn test_connection(url: &str, key: Option<String>) -> SyncConnectionResult {
    let client = match SyncClient::new(url, key) {
        Ok(client) => client,
        Err(e) => {
            return SyncConnectionResult {
                ok: false,
                name: None,
                version: None,
                error: Some(e.to_string()),
            }
        }
    };
    match client.health().await {
        Ok(info) => SyncConnectionResult {
            ok: info.ok,
            name: info.name,
            version: info.version,
            error: None,
        },
        Err(e) => SyncConnectionResult {
            ok: false,
            name: None,
            version: None,
            error: Some(e.to_string()),
        },
    }
}

pub async fn list_world_backups(profile_id: Uuid) -> Result<Vec<RemoteWorldBackup>> {
    let client = client_from_config().await?;
    client.list_world_backups(&profile_id.to_string()).await
}

pub async fn restore_world_backup(profile_id: Uuid, world: &str, backup_id: &str) -> Result<()> {
    let client = client_from_config().await?;
    let state = crate::state::State::get().await?;
    let instance_dir = state
        .profile_manager
        .get_profile_instance_path(profile_id)
        .await?;
    let world_dir = instance_dir.join("saves").join(world);

    if fs::metadata(&world_dir).await.map(|m| m.is_dir()).unwrap_or(false) {
        let _ = local_world_backup(&profile_id, world, &world_dir).await;
    }

    let zip_bytes = client
        .download_world_backup(&profile_id.to_string(), world, backup_id)
        .await?;
    extract_zip_into(zip_bytes, &world_dir).await?;
    Ok(())
}

pub async fn run(
    manager: &CloudSyncManager,
    url: &str,
    key: Option<String>,
) -> std::result::Result<SyncReport, SyncFailure> {
    let client = SyncClient::new(url, key)?;
    let state = crate::state::State::get()
        .await
        .map_err(|e| SyncFailure::Other(e.to_string()))?;
    let profiles = state
        .profile_manager
        .list_profiles()
        .await
        .map_err(|e| SyncFailure::Other(e.to_string()))?;

    let mut plans: Vec<ProfilePlan> = Vec::new();
    let mut total: u64 = 0;

    for profile in &profiles {
        let instance_dir = match state
            .profile_manager
            .get_profile_instance_path(profile.id)
            .await
        {
            Ok(path) => path,
            Err(_) => continue,
        };
        let local = build_local_manifest(&instance_dir).await?;
        let remote = client.get_manifest(&profile.id.to_string()).await?;
        let items = diff(&local, &remote);
        total += items.len() as u64;
        plans.push(ProfilePlan {
            id: profile.id,
            name: profile.name.clone(),
            instance_dir,
            local,
            items,
        });
    }

    let mut report = SyncReport {
        processed: 0,
        total,
        uploaded: 0,
        downloaded: 0,
    };
    let mut last_emit: i64 = 0;

    for plan in &plans {
        let profile_id = plan.id.to_string();

        for world in worlds_in(&plan.items, SyncDirection::Up) {
            match client.backup_world(&profile_id, &world).await? {
                WriteResult::StorageFull => return Err(SyncFailure::StorageFull),
                WriteResult::Written => {}
            }
        }

        for world in worlds_in(&plan.items, SyncDirection::Down) {
            let world_dir = plan.instance_dir.join("saves").join(&world);
            if fs::metadata(&world_dir).await.map(|m| m.is_dir()).unwrap_or(false) {
                let _ = local_world_backup(&plan.id, &world, &world_dir).await;
            }
        }

        for item in &plan.items {
            let now = now_ms();
            if now - last_emit > 150 {
                manager
                    .emit_running(
                        &report,
                        Some(SyncFileActivity {
                            profile_id: profile_id.clone(),
                            profile_name: plan.name.clone(),
                            path: item.rel.clone(),
                            direction: item.direction,
                        }),
                    )
                    .await;
                last_emit = now;
            }

            match item.direction {
                SyncDirection::Up => {
                    let abs = resolve(&plan.instance_dir, &item.rel);
                    let bytes = match fs::read(&abs).await {
                        Ok(bytes) => bytes,
                        Err(_) => {
                            report.processed += 1;
                            continue;
                        }
                    };
                    let (mtime, hash) = match plan.local.get(&item.rel) {
                        Some(entry) => (entry.mtime, entry.hash.clone()),
                        None => (now_ms(), String::new()),
                    };
                    match client.upload(&profile_id, &item.rel, bytes, mtime, &hash).await? {
                        WriteResult::StorageFull => return Err(SyncFailure::StorageFull),
                        WriteResult::Written => report.uploaded += 1,
                    }
                }
                SyncDirection::Down => {
                    let bytes = client.download(&profile_id, &item.rel).await?;
                    let abs = resolve(&plan.instance_dir, &item.rel);
                    write_atomic(&abs, &bytes).await?;
                    report.downloaded += 1;
                }
            }
            report.processed += 1;
        }
    }

    Ok(report)
}
