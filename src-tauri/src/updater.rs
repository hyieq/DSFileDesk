//! GitHub Releases updater. Downloads stay in the application cache until the
//! user chooses Install; a release asset's SHA-256 is verified before execution.
use crate::{synology::network, Result};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REPOSITORY: &str = "hyieq/DSFileDesk";
const MAX_MSI_SIZE: u64 = 1024 * 1024 * 1024;
const MAX_METADATA_SIZE: usize = 1024 * 1024;
#[derive(Default)]
pub struct UpdateState(tokio::sync::Mutex<UpdateCache>);
#[derive(Default)]
struct UpdateCache {
    release: Option<AvailableUpdate>,
    downloaded: Option<PathBuf>,
}
#[derive(Clone, Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    assets: Vec<ReleaseAsset>,
}
#[derive(Clone)]
struct AvailableUpdate {
    version: String,
    asset: ReleaseAsset,
    checksum_url: Option<String>,
    sha256: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    size: u64,
    notes: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    done: u64,
    total: u64,
}
fn client() -> Result<Client> {
    Client::builder()
        .user_agent(concat!("FileDesk/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or_default();
            if attempt.previous().len() >= 5
                || attempt.url().scheme() != "https"
                || !matches!(
                    host,
                    "github.com"
                        | "api.github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(network)
}
fn valid_asset_url(value: &str, tag: &str) -> bool {
    Url::parse(value)
        .map(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url
                    .path()
                    .starts_with(&format!("/{REPOSITORY}/releases/download/{tag}/"))
        })
        .unwrap_or(false)
}
fn hash_string(value: &str) -> Option<String> {
    let value = value.strip_prefix("sha256:").unwrap_or(value);
    (value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}
fn select_update(release: Release, current: &str) -> Result<(UpdateInfo, Option<AvailableUpdate>)> {
    let current = Version::parse(current).map_err(|_| "当前版本号无效")?;
    let latest = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|_| "GitHub Release 版本号无效")?;
    if release.draft || release.prerelease || !latest.pre.is_empty() {
        return Err("暂无正式版更新".into());
    }
    let mut info = UpdateInfo {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        available: latest > current,
        size: 0,
        notes: release
            .body
            .unwrap_or_default()
            .chars()
            .take(8000)
            .collect(),
    };
    if !info.available {
        return Ok((info, None));
    }
    let filename = format!("FileDesk-{latest}-windows-x64.msi");
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == filename)
        .ok_or("新版本尚未提供 Windows x64 MSI，请稍后重试")?
        .clone();
    if asset.size == 0
        || asset.size > MAX_MSI_SIZE
        || !valid_asset_url(&asset.browser_download_url, &release.tag_name)
    {
        return Err("更新安装包信息无效".into());
    }
    let sha256 = asset.digest.as_deref().and_then(hash_string);
    let checksum_url = release
        .assets
        .iter()
        .find(|asset| {
            asset.name == "SHA256SUMS.txt"
                && valid_asset_url(&asset.browser_download_url, &release.tag_name)
        })
        .map(|asset| asset.browser_download_url.clone());
    if sha256.is_none() && checksum_url.is_none() {
        return Err("更新缺少 SHA-256 校验信息".into());
    }
    info.size = asset.size;
    Ok((
        info,
        Some(AvailableUpdate {
            version: latest.to_string(),
            asset,
            checksum_url,
            sha256,
        }),
    ))
}
async fn small_response(response: reqwest::Response, max: usize) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network)?;
        if data.len() + chunk.len() > max {
            return Err("更新服务响应过大".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
#[tauri::command]
pub async fn check_update(state: State<'_, UpdateState>) -> Result<UpdateInfo> {
    let mut cache = state.0.try_lock().map_err(|_| "正在处理更新，请稍候")?;
    cache.release = None;
    cache.downloaded = None;
    let (info, update) = fetch_latest(env!("CARGO_PKG_VERSION")).await?;
    cache.release = update;
    Ok(info)
}
async fn fetch_latest(current: &str) -> Result<(UpdateInfo, Option<AvailableUpdate>)> {
    let response = client()?
        .get(format!(
            "https://api.github.com/repos/{REPOSITORY}/releases/latest"
        ))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(network)?;
    match response.status().as_u16() {
        404 => return Err("GitHub 尚无可用正式版，或发布仓库无法公开访问".into()),
        403 | 429 => return Err("GitHub 请求受限，请稍后再检查更新".into()),
        _ => (),
    }
    let bytes = small_response(
        response.error_for_status().map_err(network)?,
        MAX_METADATA_SIZE,
    )
    .await?;
    let release = serde_json::from_slice(&bytes).map_err(|_| "GitHub 更新信息格式无效")?;
    let (info, update) = select_update(release, current)?;
    Ok((info, update))
}
fn checksum_for_file(text: &str, name: &str) -> Result<String> {
    text.lines()
        .find_map(|line| {
            let (hash, file) = line.split_once(char::is_whitespace)?;
            (file.trim().trim_start_matches('*') == name)
                .then(|| hash_string(hash))
                .flatten()
        })
        .ok_or("校验文件不包含此安装包的 SHA-256".into())
}
async fn verify_file(path: &std::path::Path, expected: &str, size: u64) -> Result<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;
    if file.metadata().await.map_err(|e| e.to_string())?.len() != size {
        return Err("更新文件长度不正确，请重新下载".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 128 * 1024];
    loop {
        let n = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("更新文件 SHA-256 校验失败，请重新下载".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, state: State<'_, UpdateState>) -> Result<()> {
    let mut cache = state.0.try_lock().map_err(|_| "正在处理更新，请稍候")?;
    cache.downloaded = None;
    let mut update = cache.release.clone().ok_or("请先检查更新")?;
    let client = client()?;
    let expected = if let Some(hash) = &update.sha256 {
        hash.clone()
    } else {
        let response = client
            .get(update.checksum_url.as_ref().ok_or("更新缺少校验文件")?)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(network)?
            .error_for_status()
            .map_err(network)?;
        let data = small_response(response, 64 * 1024).await?;
        checksum_for_file(
            std::str::from_utf8(&data).map_err(|_| "校验文件编码错误")?,
            &update.asset.name,
        )?
    };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates")
        .join(&update.version);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let target = dir.join(&update.asset.name);
    let partial = target.with_extension("msi.part");
    let result: Result<()> = async {
        let response = client
            .get(&update.asset.browser_download_url)
            .send()
            .await
            .map_err(network)?
            .error_for_status()
            .map_err(network)?;
        if response
            .content_length()
            .is_some_and(|length| length != update.asset.size)
        {
            return Err("更新安装包长度与 Release 不符".into());
        }
        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|e| e.to_string())?;
        let mut stream = response.bytes_stream();
        let mut done: u64 = 0;
        let mut last = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(network)?;
            done += chunk.len() as u64;
            if done > update.asset.size {
                return Err("更新安装包超过声明长度".into());
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            if last.elapsed() >= Duration::from_millis(150) || done == update.asset.size {
                let _ = app.emit(
                    "update-progress",
                    UpdateProgress {
                        done,
                        total: update.asset.size,
                    },
                );
                last = std::time::Instant::now();
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        verify_file(&partial, &expected, update.asset.size).await?;
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    result?;
    update.sha256 = Some(expected);
    cache.release = Some(update);
    cache.downloaded = Some(target);
    Ok(())
}
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, state: State<'_, UpdateState>) -> Result<()> {
    let cache = state.0.try_lock().map_err(|_| "正在处理更新，请稍候")?;
    let path = cache.downloaded.as_ref().ok_or("请先下载更新")?;
    let update = cache.release.as_ref().ok_or("请先检查更新")?;
    verify_file(
        path,
        update.sha256.as_deref().ok_or("更新缺少校验信息")?,
        update.asset.size,
    )
    .await?;
    if !app
        .state::<crate::AppState>()
        .cancellations
        .lock()
        .unwrap()
        .is_empty()
    {
        return Err("请等待文件传输完成后安装更新".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("msiexec.exe")
            .arg("/i")
            .arg(path)
            .arg("/norestart")
            .spawn()
            .map_err(|e| format!("无法启动安装程序：{e}"))?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("当前更新安装包仅适用于 Windows x64".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(version: &str) -> Release {
        serde_json::from_value(serde_json::json!({
            "tag_name":format!("v{version}"),"body":"Release notes","assets":[{
                "name":format!("FileDesk-{version}-windows-x64.msi"),"size":128,
                "browser_download_url":format!("https://github.com/{REPOSITORY}/releases/download/v{version}/FileDesk-{version}-windows-x64.msi"),
                "digest":format!("sha256:{}", "a".repeat(64))
            }]
        })).unwrap()
    }
    #[test]
    fn compares_versions_and_never_downgrades_or_installs_previews() {
        assert!(
            select_update(release("0.10.0"), "0.9.0")
                .unwrap()
                .0
                .available
        );
        assert!(
            !select_update(release("0.4.0"), "0.4.0")
                .unwrap()
                .0
                .available
        );
        assert!(
            !select_update(release("0.3.8"), "0.4.0")
                .unwrap()
                .0
                .available
        );
        let mut preview = release("0.5.0");
        preview.prerelease = true;
        assert!(select_update(preview, "0.4.0").is_err());
    }
    #[test]
    fn only_accepts_our_msi_and_trusted_github_release_urls() {
        let mut wrong = release("0.5.0");
        wrong.assets[0].name = "../evil.msi".into();
        assert!(select_update(wrong, "0.4.0").is_err());
        for url in [
            "http://github.com/hyieq/DSFileDesk/releases/download/v0.5.0/a.msi",
            "https://evil.test/a.msi",
            "https://github.com/other/repo/releases/download/v0.5.0/a.msi",
        ] {
            let mut wrong = release("0.5.0");
            wrong.assets[0].browser_download_url = url.into();
            assert!(select_update(wrong, "0.4.0").is_err());
        }
        let mut unsigned = release("0.5.0");
        unsigned.assets[0].digest = None;
        assert!(select_update(unsigned, "0.4.0").is_err());
    }
    #[test]
    fn parses_checksum_file_without_confusing_other_assets() {
        let hash = "b".repeat(64);
        assert_eq!(
            checksum_for_file(
                &format!("{}  other.msi\n{hash} *wanted.msi\n", "a".repeat(64)),
                "wanted.msi"
            )
            .unwrap(),
            hash
        );
        assert!(checksum_for_file("bad  wanted.msi", "wanted.msi").is_err());
    }
    #[tokio::test]
    async fn detects_corrupted_and_truncated_installers() {
        let path =
            std::env::temp_dir().join(format!("filedesk-update-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"installer payload").await.unwrap();
        let hash = format!("{:x}", Sha256::digest(b"installer payload"));
        verify_file(&path, &hash, 17).await.unwrap();
        assert!(verify_file(&path, &hash, 18).await.is_err());
        tokio::fs::write(&path, b"corrupted payload").await.unwrap();
        assert!(verify_file(&path, &hash, 17).await.is_err());
        tokio::fs::remove_file(path).await.unwrap();
    }
    #[tokio::test]
    #[ignore = "requires a published public GitHub Release"]
    async fn published_github_release_is_readable_and_msi_download_works() {
        let (info, update) = fetch_latest("0.0.0").await.unwrap();
        assert!(info.available);
        let update = update.unwrap();
        let response = client()
            .unwrap()
            .get(&update.asset.browser_download_url)
            .header("Range", "bytes=0-7")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        let bytes = small_response(response, 8).await.unwrap();
        assert_eq!(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        let checksum = client()
            .unwrap()
            .get(update.checksum_url.as_ref().unwrap())
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let checksum = small_response(checksum, 65536).await.unwrap();
        let hash =
            checksum_for_file(std::str::from_utf8(&checksum).unwrap(), &update.asset.name).unwrap();
        if let Some(digest) = update.sha256 {
            assert_eq!(hash, digest);
        }
    }
}
