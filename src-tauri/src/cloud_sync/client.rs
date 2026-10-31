use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

pub struct SyncClient {
    base: String,
    key: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteResult {
    Written,
    StorageFull,
    Missing,
}

#[derive(Debug, Deserialize)]
pub struct HealthInfo {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RemoteEntry {
    pub hash: String,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Debug, Deserialize)]
struct RemoteManifestDto {
    #[serde(default)]
    files: HashMap<String, RemoteEntryDto>,
}

#[derive(Debug, Deserialize)]
struct RemoteEntryDto {
    #[serde(default)]
    hash: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    mtime: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteWorldBackup {
    pub world: String,
    pub id: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
struct WorldBackupsDto {
    #[serde(default)]
    backups: Vec<RemoteWorldBackup>,
}

impl SyncClient {
    pub fn new(url: &str, key: Option<String>) -> Result<Self> {
        let base = url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err(AppError::Other("Sync API URL is empty".to_string()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        let key = key.and_then(|k| {
            let trimmed = k.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        Ok(Self { base, key, http })
    }

    fn auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.key {
            Some(key) => builder.bearer_auth(key),
            None => builder,
        }
    }

    pub async fn health(&self) -> Result<HealthInfo> {
        let url = format!("{}/health", self.base);
        let resp = self.auth(self.http.get(url)).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!("Server returned {}", resp.status())));
        }
        Ok(resp.json::<HealthInfo>().await?)
    }

    pub async fn get_manifest(&self, profile_id: &str) -> Result<HashMap<String, RemoteEntry>> {
        let url = format!("{}/profiles/{}/manifest", self.base, profile_id);
        let resp = self.auth(self.http.get(url)).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Manifest request failed: {}",
                resp.status()
            )));
        }
        let dto = resp.json::<RemoteManifestDto>().await?;
        let map = dto
            .files
            .into_iter()
            .map(|(path, entry)| {
                (
                    path,
                    RemoteEntry {
                        hash: entry.hash,
                        size: entry.size,
                        mtime: entry.mtime,
                    },
                )
            })
            .collect();
        Ok(map)
    }

    pub async fn download(&self, profile_id: &str, rel: &str) -> Result<Vec<u8>> {
        let url = format!("{}/profiles/{}/file", self.base, profile_id);
        let resp = self
            .auth(self.http.get(url).query(&[("path", rel)]))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Download failed for {}: {}",
                rel,
                resp.status()
            )));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    pub async fn upload(
        &self,
        profile_id: &str,
        rel: &str,
        bytes: Vec<u8>,
        mtime_ms: i64,
        hash: &str,
    ) -> Result<WriteResult> {
        let url = format!("{}/profiles/{}/file", self.base, profile_id);
        let resp = self
            .auth(
                self.http
                    .put(url)
                    .query(&[("path", rel)])
                    .header("x-mtime-ms", mtime_ms.to_string())
                    .header("x-sha256", hash)
                    .header("content-type", "application/octet-stream")
                    .body(bytes),
            )
            .send()
            .await?;
        if resp.status().as_u16() == 507 {
            return Ok(WriteResult::StorageFull);
        }
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Upload failed for {}: {}",
                rel,
                resp.status()
            )));
        }
        Ok(WriteResult::Written)
    }

    pub async fn backup_world(&self, profile_id: &str, world: &str) -> Result<WriteResult> {
        let url = format!("{}/profiles/{}/worldbackup", self.base, profile_id);
        let resp = self
            .auth(self.http.post(url).query(&[("world", world)]))
            .send()
            .await?;
        if resp.status().as_u16() == 507 {
            return Ok(WriteResult::StorageFull);
        }
        if resp.status().as_u16() == 404 {
            return Ok(WriteResult::Missing);
        }
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "World backup failed for {}: {}",
                world,
                resp.status()
            )));
        }
        Ok(WriteResult::Written)
    }

    pub async fn list_world_backups(&self, profile_id: &str) -> Result<Vec<RemoteWorldBackup>> {
        let url = format!("{}/profiles/{}/worldbackups", self.base, profile_id);
        let resp = self.auth(self.http.get(url)).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Listing world backups failed: {}",
                resp.status()
            )));
        }
        let dto = resp.json::<WorldBackupsDto>().await?;
        Ok(dto.backups)
    }

    pub async fn download_world_backup(
        &self,
        profile_id: &str,
        world: &str,
        backup_id: &str,
    ) -> Result<Vec<u8>> {
        let url = format!("{}/profiles/{}/worldbackup", self.base, profile_id);
        let resp = self
            .auth(
                self.http
                    .get(url)
                    .query(&[("world", world), ("id", backup_id)]),
            )
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "World backup download failed: {}",
                resp.status()
            )));
        }
        Ok(resp.bytes().await?.to_vec())
    }
}
