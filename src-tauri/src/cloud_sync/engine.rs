use super::client::{RemoteEntry, RemoteWorldBackup, SyncClient, WriteResult};
use super::{
    now_ms, CloudSyncManager, SyncDirection, SyncFailure, SyncFileActivity, SyncMode, SyncReport,
};
use crate::config::{ProjectDirsExt, LAUNCHER_DIRECTORY};
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tokio::fs;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;
use uuid::Uuid;

const SYNC_DIR_ROOTS: [&str; 5] = ["saves", "mods", "resourcepacks", "shaderpacks", "config"];
const SYNC_FILE_ROOTS: [&str; 2] = ["options.txt", "servers.dat"];
const LOCAL_BACKUP_RETENTION_MS: i64 = 14 * 24 * 60 * 60 * 1000;
const UPLOAD_CONCURRENCY: usize = 8;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    mtime: i64,
    size: u64,
    hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HashCache {
    #[serde(default)]
    files: HashMap<String, CacheEntry>,
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

enum Outcome {
    Uploaded,
    Downloaded,
    Skipped,
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

fn hash_cache_root() -> PathBuf {
    LAUNCHER_DIRECTORY.meta_dir().join("cloud_sync_cache")
}

fn hash_cache_path(profile_id: Uuid) -> PathBuf {
    hash_cache_root().join(format!("{}.json", profile_id))
}

async fn load_hash_cache(profile_id: Uuid) -> HashMap<String, CacheEntry> {
    match fs::read(hash_cache_path(profile_id)).await {
        Ok(bytes) => serde_json::from_slice::<HashCache>(&bytes)
            .map(|cache| cache.files)
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

async fn save_hash_cache(profile_id: Uuid, files: &HashMap<String, CacheEntry>) {
    let root = hash_cache_root();
    if fs::create_dir_all(&root).await.is_err() {
        return;
    }
    let cache = HashCache {
        files: files.clone(),
    };
    if let Ok(json) = serde_json::to_vec(&cache) {
        let target = hash_cache_path(profile_id);
        let tmp = root.join(format!(".{}.tmp-{}", profile_id, Uuid::new_v4().simple()));
        if fs::write(&tmp, &json).await.is_ok() {
            let _ = fs::rename(&tmp, &target).await;
        }
    }
}

async fn collect_dir(
    root: &Path,
    prefix: &str,
    out: &mut Vec<(String, PathBuf, i64, u64)>,
) -> Result<()> {
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
                out.push((rel, path, mtime_ms(&meta), meta.len()));
            }
        }
    }
    Ok(())
}

async fn collect_files(instance_dir: &Path) -> Result<Vec<(String, PathBuf, i64, u64)>> {
    let mut out = Vec::new();
    for root in SYNC_DIR_ROOTS {
        let dir = instance_dir.join(root);
        if fs::metadata(&dir).await.map(|m| m.is_dir()).unwrap_or(false) {
            collect_dir(&dir, root, &mut out).await?;
        }
    }
    for file in SYNC_FILE_ROOTS {
        let path = instance_dir.join(file);
        if let Ok(meta) = fs::metadata(&path).await {
            if meta.is_file() {
                out.push((file.to_string(), path, mtime_ms(&meta), meta.len()));
            }
        }
    }
    Ok(out)
}

async fn hash_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex_encode(&hasher.finalize()))
}

async fn build_local_manifest(
    profile_id: Uuid,
    instance_dir: &Path,
) -> Result<HashMap<String, LocalEntry>> {
    let files = collect_files(instance_dir).await?;
    let cache = load_hash_cache(profile_id).await;
    let mut out = HashMap::new();
    let mut next_cache: HashMap<String, CacheEntry> = HashMap::new();

    for (rel, abs, mtime, size) in files {
        let hash = match cache.get(&rel) {
            Some(entry) if entry.mtime == mtime && entry.size == size => entry.hash.clone(),
            _ => match hash_file(&abs).await {
                Ok(hash) => hash,
                Err(_) => continue,
            },
        };
        next_cache.insert(
            rel.clone(),
            CacheEntry {
                mtime,
                size,
                hash: hash.clone(),
            },
        );
        out.insert(rel, LocalEntry { hash, mtime });
    }

    save_hash_cache(profile_id, &next_cache).await;
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

fn pull_all_items(
    local: &HashMap<String, LocalEntry>,
    remote: &HashMap<String, RemoteEntry>,
) -> Vec<PlanItem> {
    let mut items = Vec::new();
    for (rel, entry) in remote {
        if !is_safe_rel(rel) {
            continue;
        }
        let same = local.get(rel).map(|l| l.hash == entry.hash).unwrap_or(false);
        if same {
            continue;
        }
        items.push(PlanItem {
            rel: rel.clone(),
            direction: SyncDirection::Down,
        });
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

async fn transfer_one(
    client: &SyncClient,
    plan: &ProfilePlan,
    item: &PlanItem,
    profile_id: &str,
) -> std::result::Result<Outcome, SyncFailure> {
    match item.direction {
        SyncDirection::Up => {
            let abs = resolve(&plan.instance_dir, &item.rel);
            let bytes = match fs::read(&abs).await {
                Ok(bytes) => bytes,
                Err(_) => return Ok(Outcome::Skipped),
            };
            let (mtime, hash) = match plan.local.get(&item.rel) {
                Some(entry) => (entry.mtime, entry.hash.clone()),
                None => (now_ms(), String::new()),
            };
            match client.upload(profile_id, &item.rel, bytes, mtime, &hash).await? {
                WriteResult::StorageFull => Err(SyncFailure::StorageFull),
                _ => Ok(Outcome::Uploaded),
            }
        }
        SyncDirection::Down => {
            let bytes = client.download(profile_id, &item.rel).await?;
            let abs = resolve(&plan.instance_dir, &item.rel);
            write_atomic(&abs, &bytes).await?;
            Ok(Outcome::Downloaded)
        }
    }
}

async fn sync_profile_metadata(
    state: &crate::state::State,
    client: &SyncClient,
    mode: SyncMode,
) -> Result<()> {
    let server_metas = client.list_profile_metas().await?;
    let local = state.profile_manager.list_profiles().await?;
    let local_ids: HashSet<Uuid> = local.iter().map(|p| p.id).collect();

    if mode == SyncMode::Bidirectional {
        for profile in &local {
            if let Ok(value) = serde_json::to_value(profile) {
                if let Err(e) = client
                    .upload_profile_meta(&profile.id.to_string(), value)
                    .await
                {
                    log::warn!("[cloud_sync] upload profile meta {} failed: {}", profile.id, e);
                }
            }
        }
    }

    for remote in server_metas {
        let id = match Uuid::parse_str(&remote.id) {
            Ok(id) => id,
            Err(_) => continue,
        };
        if local_ids.contains(&id) {
            continue;
        }
        match serde_json::from_value::<crate::state::profile_state::Profile>(remote.meta) {
            Ok(profile) => {
                if profile.id != id || profile.path.contains("..") {
                    continue;
                }
                if let Err(e) = state.profile_manager.create_profile(profile).await {
                    log::warn!("[cloud_sync] create profile {} from cloud failed: {}", id, e);
                }
            }
            Err(e) => {
                log::warn!("[cloud_sync] parse profile meta {} failed: {}", id, e);
            }
        }
    }
    Ok(())
}

pub async fn run(
    manager: Arc<CloudSyncManager>,
    url: &str,
    key: Option<String>,
    mode: SyncMode,
) -> std::result::Result<SyncReport, SyncFailure> {
    super::clear_cancelled_profiles();
    let client = Arc::new(SyncClient::new(url, key)?);
    let state = crate::state::State::get()
        .await
        .map_err(|e| SyncFailure::Other(e.to_string()))?;

    if let Err(e) = sync_profile_metadata(&state, &client, mode).await {
        log::warn!("[cloud_sync] profile metadata sync failed: {}", e);
    }

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
        if super::is_profile_cancelled(&profile.id) {
            continue;
        }
        manager.emit_scanning(&profile.name).await;
        let local = build_local_manifest(profile.id, &instance_dir).await?;
        let remote = client.get_manifest(&profile.id.to_string()).await?;
        let items = match mode {
            SyncMode::Bidirectional => diff(&local, &remote),
            SyncMode::PullAll => pull_all_items(&local, &remote),
        };
        total += items.len() as u64;
        plans.push(ProfilePlan {
            id: profile.id,
            name: profile.name.clone(),
            instance_dir,
            local,
            items,
        });
    }

    let processed = Arc::new(AtomicU64::new(0));
    let uploaded = Arc::new(AtomicU64::new(0));
    let downloaded = Arc::new(AtomicU64::new(0));
    let abort = Arc::new(AtomicBool::new(false));
    let failure: Arc<Mutex<Option<SyncFailure>>> = Arc::new(Mutex::new(None));
    let semaphore = Arc::new(Semaphore::new(UPLOAD_CONCURRENCY));

    for plan in plans {
        if abort.load(Ordering::SeqCst) {
            break;
        }
        if super::is_profile_cancelled(&plan.id) {
            continue;
        }
        let profile_id = plan.id.to_string();

        for world in worlds_in(&plan.items, SyncDirection::Up) {
            match client.backup_world(&profile_id, &world).await {
                Ok(WriteResult::StorageFull) => {
                    abort.store(true, Ordering::SeqCst);
                    *failure.lock().await = Some(SyncFailure::StorageFull);
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    abort.store(true, Ordering::SeqCst);
                    *failure.lock().await = Some(SyncFailure::Other(e.to_string()));
                    break;
                }
            }
        }
        if abort.load(Ordering::SeqCst) {
            break;
        }

        for world in worlds_in(&plan.items, SyncDirection::Down) {
            let world_dir = plan.instance_dir.join("saves").join(&world);
            if fs::metadata(&world_dir).await.map(|m| m.is_dir()).unwrap_or(false) {
                let _ = local_world_backup(&plan.id, &world, &world_dir).await;
            }
        }

        let plan = Arc::new(plan);
        let count = plan.items.len();
        let mut set: JoinSet<()> = JoinSet::new();

        for idx in 0..count {
            if abort.load(Ordering::SeqCst) {
                break;
            }
            let permit = match semaphore.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let client = client.clone();
            let manager = manager.clone();
            let plan = plan.clone();
            let processed = processed.clone();
            let uploaded = uploaded.clone();
            let downloaded = downloaded.clone();
            let abort = abort.clone();
            let failure = failure.clone();
            let profile_id = profile_id.clone();

            set.spawn(async move {
                let _permit = permit;
                if abort.load(Ordering::SeqCst) || super::is_profile_cancelled(&plan.id) {
                    return;
                }
                let item = &plan.items[idx];
                let activity = SyncFileActivity {
                    profile_id: profile_id.clone(),
                    profile_name: plan.name.clone(),
                    path: item.rel.clone(),
                    direction: item.direction,
                };
                match transfer_one(&client, &plan, item, &profile_id).await {
                    Ok(Outcome::Uploaded) => {
                        uploaded.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(Outcome::Downloaded) => {
                        downloaded.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(Outcome::Skipped) => {}
                    Err(f) => {
                        abort.store(true, Ordering::SeqCst);
                        let mut guard = failure.lock().await;
                        if guard.is_none() {
                            *guard = Some(f);
                        }
                    }
                }
                let done = processed.fetch_add(1, Ordering::SeqCst) + 1;
                manager
                    .emit_progress(
                        done,
                        total,
                        uploaded.load(Ordering::SeqCst),
                        downloaded.load(Ordering::SeqCst),
                        Some(activity),
                    )
                    .await;
            });
        }

        while set.join_next().await.is_some() {}
        if abort.load(Ordering::SeqCst) {
            break;
        }
    }

    if let Some(failure) = failure.lock().await.take() {
        return Err(failure);
    }

    Ok(SyncReport {
        processed: processed.load(Ordering::SeqCst),
        total,
        uploaded: uploaded.load(Ordering::SeqCst),
        downloaded: downloaded.load(Ordering::SeqCst),
    })
}
