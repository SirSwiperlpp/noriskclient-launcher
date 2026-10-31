use crate::cloud_sync::client::RemoteWorldBackup;
use crate::cloud_sync::engine::{self, SyncConnectionResult};
use crate::cloud_sync::{CloudSyncManager, SyncStatus};
use crate::error::{AppError, CommandError};
use std::sync::Arc;
use tauri::command;
use uuid::Uuid;

type Result<T> = std::result::Result<T, CommandError>;

fn manager() -> Result<Arc<CloudSyncManager>> {
    CloudSyncManager::get().ok_or_else(|| {
        CommandError::from(AppError::Other("Cloud sync is not initialized".to_string()))
    })
}

#[command]
pub async fn sync_get_status() -> Result<SyncStatus> {
    Ok(manager()?.snapshot().await)
}

#[command]
pub async fn sync_is_running() -> Result<bool> {
    Ok(manager()?.is_running())
}

#[command]
pub async fn sync_refresh() -> Result<SyncStatus> {
    Ok(manager()?.refresh().await)
}

#[command]
pub async fn sync_now() -> Result<()> {
    let manager = manager()?;
    let state = crate::state::State::get().await?;
    let config = state.config_manager.get_config().await;

    if !config.sync_enabled {
        return Err(CommandError::from(AppError::Other(
            "Cloud sync is disabled".to_string(),
        )));
    }
    if config
        .sync_api_url
        .as_deref()
        .map(|url| url.trim().is_empty())
        .unwrap_or(true)
    {
        return Err(CommandError::from(AppError::Other(
            "Set the sync API URL first".to_string(),
        )));
    }
    if manager.is_running() {
        return Ok(());
    }
    if !manager.processes_idle().await {
        return Err(CommandError::from(AppError::Other(
            "Close all running instances before syncing".to_string(),
        )));
    }

    manager.trigger("manual");
    Ok(())
}

#[command]
pub async fn sync_test_connection(
    url: String,
    api_key: Option<String>,
) -> Result<SyncConnectionResult> {
    Ok(engine::test_connection(&url, api_key).await)
}

#[command]
pub async fn sync_list_world_backups(profile_id: Uuid) -> Result<Vec<RemoteWorldBackup>> {
    Ok(engine::list_world_backups(profile_id).await?)
}

#[command]
pub async fn sync_restore_world_backup(
    profile_id: Uuid,
    world: String,
    backup_id: String,
) -> Result<()> {
    let manager = manager()?;
    if !manager.processes_idle().await {
        return Err(CommandError::from(AppError::Other(
            "Close all running instances before restoring".to_string(),
        )));
    }
    engine::restore_world_backup(profile_id, &world, &backup_id).await?;
    Ok(())
}
