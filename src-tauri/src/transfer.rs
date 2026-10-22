use crate::{
    session,
    synology::{decode, network, validate_name, Session},
    AppState, Result,
};
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    name: String,
    done: u64,
    total: u64,
    status: String,
}
fn progress(app: &tauri::AppHandle, id: &str, name: &str, done: u64, total: u64, status: &str) {
    let _ = app.emit(
        "transfer-progress",
        Progress {
            id: id.into(),
            name: name.into(),
            done,
            total,
            status: status.into(),
        },
    );
}
fn begin(state: &AppState, id: &str) -> Result<Arc<CancellationToken>> {
    let mut tasks = state.cancellations.lock().unwrap();
    if tasks.contains_key(id) {
        return Err("任务 ID 已存在".into());
    }
    let token = Arc::new(CancellationToken::new());
    tasks.insert(id.into(), token.clone());
    Ok(token)
}
#[tauri::command]
pub fn cancel_transfer(state: State<AppState>, task_id: String) {
    if let Some(token) = state.cancellations.lock().unwrap().get(&task_id) {
        token.cancel();
    }
}
async fn save_download(
    s: &Session,
    paths: &[String],
    dest: &Path,
    app: &tauri::AppHandle,
    task: &str,
    cancel: &CancellationToken,
) -> Result<()> {
    let (url, ver) = s.endpoint("SYNO.FileStation.Download")?;
    let name = dest
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let response = tokio::select! {
        _=cancel.cancelled()=>return Err("已取消".into()),
        r=s.client.get(url).query(&[("api","SYNO.FileStation.Download".into()),("version",ver.to_string()),("method","download".into()),("path",serde_json::json!(paths).to_string()),("mode","download".into()),("_sid",s.sid.clone())]).send()=>r.map_err(network)?.error_for_status().map_err(network)?
    };
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // DSM errors arrive as JSON without a download disposition; real .json files remain valid downloads.
    if content_type.contains("application/json")
        && response.headers().get("content-disposition").is_none()
    {
        let v = response.json().await.map_err(network)?;
        decode(v)?;
        return Err("NAS 未返回下载内容".into());
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .await
        .map_err(|e| format!("无法创建目标文件（不覆盖已有文件）：{e}"))?;
    let result=async {
        let mut stream=response.bytes_stream(); let mut done=0;
        loop { tokio::select! {
            _=cancel.cancelled()=>return Err("已取消".into()),
            chunk=stream.next()=>match chunk {
                None=>break,
                Some(chunk)=>{ let bytes=chunk.map_err(network)?; file.write_all(&bytes).await.map_err(|e|e.to_string())?; let previous=done; done+=bytes.len() as u64; if done/524288 != previous/524288 || done==total { progress(app,task,&name,done,total,"running"); } }
            }
        }}
        file.flush().await.map_err(|e|e.to_string())?;
        Ok(())
    }.await;
    drop(file);
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}
#[tauri::command]
pub async fn download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    paths: Vec<String>,
    destination: String,
    task_id: String,
) -> Result<()> {
    if paths.is_empty() {
        return Err("请选择文件".into());
    }
    let s = session(&state, &id)?;
    let token = begin(&state, &task_id)?;
    let result = save_download(&s, &paths, Path::new(&destination), &app, &task_id, &token).await;
    // save_download handles cancellation during streaming and removes its own partial file.
    state.cancellations.lock().unwrap().remove(&task_id);
    result
}
#[tauri::command]
pub async fn upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    paths: Vec<String>,
    destination: String,
    task_id: String,
) -> Result<()> {
    let s = session(&state, &id)?;
    let token = begin(&state, &task_id)?;
    let result=async {
        for source in paths {
            let source=PathBuf::from(source);
            let parent=source.parent().ok_or("无效的上传路径")?;
            for entry in walkdir::WalkDir::new(&source).follow_links(false) {
                if token.is_cancelled() { return Err("已取消".into()); }
                let entry=entry.map_err(|e|e.to_string())?;
                if entry.file_type().is_symlink() { return Err("上传不支持符号链接，请选择实际文件".into()); }
                let relative=entry.path().strip_prefix(parent).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
                let remote=format!("{}/{}",destination.trim_end_matches('/'),relative);
                if entry.file_type().is_dir() {
                    let (dir,name)=remote.rsplit_once('/').ok_or("无效路径")?;
                    s.call("SYNO.FileStation.CreateFolder","create",vec![("folder_path",serde_json::json!([dir]).to_string()),("name",serde_json::json!([name]).to_string()),("force_parent","true".into())]).await?;
                    continue;
                }
                let file=tokio::fs::File::open(entry.path()).await.map_err(|e|e.to_string())?;
                let total=file.metadata().await.map_err(|e|e.to_string())?.len();
                let name=entry.file_name().to_string_lossy().to_string();
                let done=Arc::new(AtomicU64::new(0)); let counter=done.clone();
                let app2=app.clone(); let task2=task_id.clone(); let name2=name.clone();
                let stream=tokio_util::io::ReaderStream::new(file).map(move |chunk| { if let Ok(bytes)=&chunk { let previous=counter.fetch_add(bytes.len() as u64,Ordering::Relaxed); let n=previous+bytes.len() as u64; if n/524288 != previous/524288 || n==total { progress(&app2,&task2,&name2,n,total,"running"); } } chunk });
                let part=reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream),total).file_name(name);
                let (url,ver)=s.endpoint("SYNO.FileStation.Upload")?;
                let folder=remote.rsplit_once('/').ok_or("无效路径")?.0;
                let form=reqwest::multipart::Form::new().text("api","SYNO.FileStation.Upload").text("version",ver.to_string()).text("method","upload").text("_sid",s.sid.clone()).text("path",folder.to_string()).text("create_parents","true").text("overwrite","false").part("file",part);
                tokio::select! {
                    _=token.cancelled()=>return Err("已取消；NAS 可能保留未完成上传，请刷新检查".into()),
                    r=s.client.post(url).multipart(form).send()=>{ let r=r.map_err(network)?.error_for_status().map_err(network)?; decode(r.json().await.map_err(network)?)?; }
                }
            }
        } Ok(())
    }.await;
    state.cancellations.lock().unwrap().remove(&task_id);
    result
}
#[tauri::command]
pub async fn prepare_drag(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
    name: String,
    task_id: String,
) -> Result<String> {
    validate_name(&name)?;
    // Unique private cache directories avoid name collisions and never overwrite another file.
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("drag")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let target = dir.join(name);
    download(
        app,
        state,
        id,
        vec![path],
        target.to_string_lossy().into(),
        task_id,
    )
    .await?;
    Ok(target.to_string_lossy().into())
}
#[tauri::command]
pub async fn native_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<()> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("drag")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let files: Vec<PathBuf> = paths
        .into_iter()
        .map(|p| {
            let p = PathBuf::from(p).canonicalize().map_err(|e| e.to_string())?;
            if !p.starts_with(&root) || !p.is_file() {
                return Err("只能拖出已缓存的文件".into());
            }
            Ok(p)
        })
        .collect::<Result<_>>()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            let result = drag::start_drag(
                &handle,
                drag::DragItem::Files(files),
                drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
                |_, _| {},
                Default::default(),
            )
            .map_err(|e| e.to_string());
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let result = Err("当前平台暂不支持原生拖出".into());
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
