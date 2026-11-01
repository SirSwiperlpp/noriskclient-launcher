use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

const CHUNK_SIZE: usize = 10 * 1024 * 1024;

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
    #[serde(default, alias = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
struct WorldBackupsDto {
    #[serde(default)]
    backups: Vec<RemoteWorldBackup>,
}

#[derive(Debug, Deserialize)]
pub struct RemoteProfileMeta {
    pub id: String,
    #[serde(default)]
    pub meta: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ProfileMetasDto {
    #[serde(default)]
    profiles: Vec<RemoteProfileMeta>,
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
        if bytes.len() > CHUNK_SIZE {
            return self
                .upload_chunked(profile_id, rel, bytes, mtime_ms, hash)
                .await;
        }
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

    async fn upload_chunked(
        &self,
        profile_id: &str,
        rel: &str,
        bytes: Vec<u8>,
        mtime_ms: i64,
        hash: &str,
    ) -> Result<WriteResult> {
        let upload_id = Uuid::new_v4().to_string();
        let total = bytes.len();
        let mut offset = 0usize;
        while offset < total {
            let end = std::cmp::min(offset + CHUNK_SIZE, total);
            let is_last = end == total;
            let chunk = bytes[offset..end].to_vec();
            let url = format!("{}/profiles/{}/filechunk", self.base, profile_id);
            let mut builder = self
                .http
                .put(url)
                .query(&[("path", rel)])
                .header("x-upload-id", upload_id.as_str())
                .header("x-offset", offset.to_string())
                .header("content-type", "application/octet-stream")
                .body(chunk);
            if is_last {
                builder = builder
                    .header("x-last", "1")
                    .header("x-total-size", total.to_string())
                    .header("x-sha256", hash)
                    .header("x-mtime-ms", mtime_ms.to_string());
            }
            let resp = self.auth(builder).send().await?;
            if resp.status().as_u16() == 507 {
                return Ok(WriteResult::StorageFull);
            }
            if !resp.status().is_success() {
                return Err(AppError::Other(format!(
                    "Chunk upload failed for {} at offset {}: {}",
                    rel,
                    offset,
                    resp.status()
                )));
            }
            offset = end;
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

    pub async fn list_profile_metas(&self) -> Result<Vec<RemoteProfileMeta>> {
        let url = format!("{}/profiles", self.base);
        let resp = self.auth(self.http.get(url)).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Listing profiles failed: {}",
                resp.status()
            )));
        }
        Ok(resp.json::<ProfileMetasDto>().await?.profiles)
    }

    pub async fn upload_profile_meta(
        &self,
        profile_id: &str,
        meta: serde_json::Value,
    ) -> Result<()> {
        let url = format!("{}/profiles/{}/meta", self.base, profile_id);
        let resp = self.auth(self.http.put(url).json(&meta)).send().await?;
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "Upload profile meta failed: {}",
                resp.status()
            )));
        }
        Ok(())
    }
}
