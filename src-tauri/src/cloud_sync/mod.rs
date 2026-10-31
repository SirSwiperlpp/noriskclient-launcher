pub mod client;
pub mod engine;

use crate::error::AppError;
use dashmap::DashSet;
use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;
use uuid::Uuid;

pub const SYNC_STATUS_EVENT: &str = "cloud_sync_status";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    Idle,
    Running,
    Error,
    Done,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncFileActivity {
    pub profile_id: String,
    pub profile_name: String,
    pub path: String,
    pub direction: SyncDirection,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub phase: SyncPhase,
    pub running: bool,
    pub message: Option<String>,
    pub error: Option<String>,
    pub storage_full: bool,
    pub processed: u64,
    pub total: u64,
    pub uploaded: u64,
    pub downloaded: u64,
    pub current: Option<SyncFileActivity>,
    pub last_synced_ms: Option<i64>,
}

impl SyncStatus {
    fn disabled() -> Self {
        Self {
            enabled: false,
            phase: SyncPhase::Disabled,
            running: false,
            message: None,
            error: None,
            storage_full: false,
            processed: 0,
            total: 0,
            uploaded: 0,
            downloaded: 0,
            current: None,
            last_synced_ms: None,
        }
    }

    fn idle(last_synced_ms: Option<i64>) -> Self {
        Self {
            enabled: true,
            phase: SyncPhase::Idle,
            running: false,
            message: None,
            error: None,
            storage_full: false,
            processed: 0,
            total: 0,
            uploaded: 0,
            downloaded: 0,
            current: None,
            last_synced_ms,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SyncReport {
    pub processed: u64,
    pub total: u64,
    pub uploaded: u64,
    pub downloaded: u64,
}

pub enum SyncFailure {
    StorageFull,
    Other(String),
}

impl From<AppError> for SyncFailure {
    fn from(error: AppError) -> Self {
        SyncFailure::Other(error.to_string())
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

static CLOUD_SYNC: OnceCell<Arc<CloudSyncManager>> = OnceCell::new();
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static CANCELLED_PROFILES: Lazy<DashSet<Uuid>> = Lazy::new(DashSet::new);

pub fn set_close_to_tray(value: bool) {
    CLOSE_TO_TRAY.store(value, Ordering::SeqCst);
}

pub fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::SeqCst)
}

pub fn cancel_profile_sync(profile_id: Uuid) {
    CANCELLED_PROFILES.insert(profile_id);
}

pub fn is_profile_cancelled(profile_id: &Uuid) -> bool {
    CANCELLED_PROFILES.contains(profile_id)
}

pub fn clear_cancelled_profiles() {
    CANCELLED_PROFILES.clear();
}

pub struct CloudSyncManager {
    app: Arc<AppHandle>,
    running: AtomicBool,
    close_requested: AtomicBool,
    last_progress: AtomicI64,
    status: Mutex<SyncStatus>,
}

impl CloudSyncManager {
    pub fn init(app: Arc<AppHandle>) -> Arc<Self> {
        let manager = Arc::new(Self {
            app,
            running: AtomicBool::new(false),
            close_requested: AtomicBool::new(false),
            last_progress: AtomicI64::new(0),
            status: Mutex::new(SyncStatus::disabled()),
        });
        let _ = CLOUD_SYNC.set(manager.clone());
        manager
    }

    pub fn get() -> Option<Arc<Self>> {
        CLOUD_SYNC.get().cloned()
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn close_requested(&self) -> bool {
        self.close_requested.load(Ordering::SeqCst)
    }

    pub fn set_close_requested(&self, value: bool) {
        self.close_requested.store(value, Ordering::SeqCst);
    }

    pub fn notify(&self, title: &str, body: &str) {
        let _ = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }

    async fn config(&self) -> Option<(bool, Option<String>, Option<String>)> {
        let state = crate::state::State::get().await.ok()?;
        let config = state.config_manager.get_config().await;
        Some((config.sync_enabled, config.sync_api_url, config.sync_api_key))
    }

    pub async fn processes_idle(&self) -> bool {
        match crate::state::State::get().await {
            Ok(state) => state.process_manager.list_processes().await.is_empty(),
            Err(_) => true,
        }
    }

    pub async fn snapshot(&self) -> SyncStatus {
        let enabled = self.config().await.map(|(e, _, _)| e).unwrap_or(false);
        let mut status = self.status.lock().await.clone();
        status.enabled = enabled;
        if !enabled {
            status.phase = SyncPhase::Disabled;
            status.running = false;
        }
        status
    }

    pub async fn refresh(&self) -> SyncStatus {
        let last = self.status.lock().await.last_synced_ms;
        let enabled = self.config().await.map(|(e, _, _)| e).unwrap_or(false);
        let status = if !enabled {
            SyncStatus::disabled()
        } else if self.is_running() {
            let mut current = self.status.lock().await.clone();
            current.enabled = true;
            current
        } else {
            SyncStatus::idle(last)
        };
        self.set_status(status.clone()).await;
        status
    }

    async fn set_status(&self, status: SyncStatus) {
        {
            let mut guard = self.status.lock().await;
            *guard = status.clone();
        }
        let _ = self.app.emit(SYNC_STATUS_EVENT, &status);
    }

    pub async fn emit_running(&self, report: &SyncReport, current: Option<SyncFileActivity>) {
        let status = SyncStatus {
            enabled: true,
            phase: SyncPhase::Running,
            running: true,
            message: None,
            error: None,
            storage_full: false,
            processed: report.processed,
            total: report.total,
            uploaded: report.uploaded,
            downloaded: report.downloaded,
            current,
            last_synced_ms: self.status.lock().await.last_synced_ms,
        };
        self.set_status(status).await;
    }

    pub async fn emit_progress(
        &self,
        processed: u64,
        total: u64,
        uploaded: u64,
        downloaded: u64,
        current: Option<SyncFileActivity>,
    ) {
        let now = now_ms();
        let last = self.last_progress.load(Ordering::Relaxed);
        if processed < total && now - last < 120 {
            return;
        }
        self.last_progress.store(now, Ordering::Relaxed);
        let status = SyncStatus {
            enabled: true,
            phase: SyncPhase::Running,
            running: true,
            message: None,
            error: None,
            storage_full: false,
            processed,
            total,
            uploaded,
            downloaded,
            current,
            last_synced_ms: self.status.lock().await.last_synced_ms,
        };
        self.set_status(status).await;
    }

    pub async fn emit_scanning(&self, profile_name: &str) {
        let status = SyncStatus {
            enabled: true,
            phase: SyncPhase::Running,
            running: true,
            message: Some(format!("Checking {}", profile_name)),
            error: None,
            storage_full: false,
            processed: 0,
            total: 0,
            uploaded: 0,
            downloaded: 0,
            current: None,
            last_synced_ms: self.status.lock().await.last_synced_ms,
        };
        self.set_status(status).await;
    }

    pub fn trigger(self: &Arc<Self>, reason: &str) {
        let manager = self.clone();
        let reason = reason.to_string();
        tauri::async_runtime::spawn(async move {
            manager.run_guarded(&reason).await;
        });
    }

    async fn run_guarded(self: &Arc<Self>, reason: &str) {
        let (enabled, url, key) = match self.config().await {
            Some(values) => values,
            None => return,
        };
        if !enabled {
            self.refresh().await;
            return;
        }
        let url = match url {
            Some(value) if !value.trim().is_empty() => value,
            _ => return,
        };
        if !self.processes_idle().await {
            return;
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        log::info!("[cloud_sync] starting sync ({})", reason);
        let last = self.status.lock().await.last_synced_ms;
        self.emit_running(&SyncReport::default(), None).await;

        let result = engine::run(self.clone(), &url, key).await;
        self.running.store(false, Ordering::SeqCst);

        match result {
            Ok(report) => {
                self.set_status(SyncStatus {
                    enabled: true,
                    phase: SyncPhase::Done,
                    running: false,
                    message: None,
                    error: None,
                    storage_full: false,
                    processed: report.processed,
                    total: report.total,
                    uploaded: report.uploaded,
                    downloaded: report.downloaded,
                    current: None,
                    last_synced_ms: Some(now_ms()),
                })
                .await;
            }
            Err(SyncFailure::StorageFull) => {
                self.set_status(SyncStatus {
                    enabled: true,
                    phase: SyncPhase::Error,
                    running: false,
                    message: None,
                    error: Some("storage_full".to_string()),
                    storage_full: true,
                    processed: 0,
                    total: 0,
                    uploaded: 0,
                    downloaded: 0,
                    current: None,
                    last_synced_ms: last,
                })
                .await;
                self.notify("Cloud Sync", "The sync server is out of storage. Sync was paused.");
            }
            Err(SyncFailure::Other(message)) => {
                log::warn!("[cloud_sync] sync failed: {}", message);
                self.set_status(SyncStatus {
                    enabled: true,
                    phase: SyncPhase::Error,
                    running: false,
                    message: None,
                    error: Some(message),
                    storage_full: false,
                    processed: 0,
                    total: 0,
                    uploaded: 0,
                    downloaded: 0,
                    current: None,
                    last_synced_ms: last,
                })
                .await;
            }
        }

        if self.close_requested.load(Ordering::SeqCst) {
            self.app.exit(0);
        }
    }
}
