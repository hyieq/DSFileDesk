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
// DSM authenticates multipart uploads before parsing the file body. Keep the
// routing and session parameters in the query, and the file as the last part.
fn upload_request(
    s: &Session,
    folder: &str,
    part: reqwest::multipart::Part,
) -> Result<reqwest::RequestBuilder> {
    let (url, version) = s.endpoint("SYNO.FileStation.Upload")?;
    let form = reqwest::multipart::Form::new()
        .text("path", folder.to_string())
        .text("create_parents", "true")
        .text("overwrite", "false")
        .part("file", part);
    Ok(s.client
        .post(url)
        .query(&[
            ("api", "SYNO.FileStation.Upload".to_string()),
            ("version", version.to_string()),
            ("method", "upload".to_string()),
            ("_sid", s.sid.clone()),
        ])
        .multipart(form))
}

#[tauri::command]
pub async fn reveal_download(path: String) -> Result<()> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err("下载文件不存在，可能已被移动或删除".into());
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg("/select,").arg(&path);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&path);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path.parent().ok_or("无法定位下载目录")?);
        command
    };
    command
        .spawn()
        .map_err(|e| format!("无法打开文件位置：{e}"))?;
    Ok(())
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
                let folder=remote.rsplit_once('/').ok_or("无效路径")?.0;
                let request=upload_request(&s,folder,part)?;
                tokio::select! {
                    _=token.cancelled()=>return Err("已取消；NAS 可能保留未完成上传，请刷新检查".into()),
                    r=request.send()=>{ let r=r.map_err(network)?.error_for_status().map_err(network)?; decode(r.json().await.map_err(network)?)?; }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn multipart_upload_authenticates_before_body_and_preserves_streamed_files() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                let (end, length) = loop {
                    let n = socket.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .expect("DSM requires a known multipart Content-Length");
                        if bytes.len() >= end + 4 + length {
                            break (end, length);
                        }
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let target = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let url = reqwest::Url::parse(&format!("http://nas{target}")).unwrap();
                let params: std::collections::HashMap<_, _> =
                    url.query_pairs().into_owned().collect();
                let valid = params.get("_sid").map(String::as_str) == Some("session+/=& value");
                let response = if valid {
                    r#"{"success":true}"#
                } else {
                    r#"{"success":false,"error":{"code":119}}"#
                };
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                assert_eq!(bytes.len() - end - 4, length);
                requests.push((params, bytes[end + 4..].to_vec(), headers.into_owned()));
            }
            requests
        });
        let mut session = Session {
            client: reqwest::Client::new(),
            base,
            sid: "session+/=& value".into(),
            apis: json!({"SYNO.FileStation.Upload":{"path":"entry.cgi","minVersion":2,"maxVersion":3}}),
        };
        let payloads = [
            b"archive-bytes\0\xff".to_vec(),
            Vec::new(),
            vec![42; 256 * 1024],
        ];
        for payload in &payloads {
            let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(payload.clone())]);
            let part = reqwest::multipart::Part::stream_with_length(
                reqwest::Body::wrap_stream(stream),
                payload.len() as u64,
            )
            .file_name("中文 archive.rar");
            let response = upload_request(&session, "/home/子目录 & +", part)
                .unwrap()
                .send()
                .await
                .unwrap();
            decode(response.json().await.unwrap()).unwrap();
        }
        session.sid = "expired".into();
        let response = upload_request(
            &session,
            "/home",
            reqwest::multipart::Part::bytes(vec![1]).file_name("a.txt"),
        )
        .unwrap()
        .send()
        .await
        .unwrap();
        assert!(decode(response.json().await.unwrap())
            .unwrap_err()
            .contains("119"));
        let requests = worker.join().unwrap();
        for (index, (params, body, headers)) in requests[..3].iter().enumerate() {
            assert_eq!(params.get("api").unwrap(), "SYNO.FileStation.Upload");
            assert_eq!(params.get("version").unwrap(), "2");
            assert_eq!(params.get("method").unwrap(), "upload");
            assert!(headers
                .to_ascii_lowercase()
                .contains("content-type: multipart/form-data; boundary="));
            assert!(!headers
                .to_ascii_lowercase()
                .contains("transfer-encoding: chunked"));
            let text = String::from_utf8_lossy(body);
            assert!(text.contains("/home/子目录 & +"));
            assert!(text.contains("name=\"create_parents\"\r\n\r\ntrue"));
            assert!(text.contains("name=\"overwrite\"\r\n\r\nfalse"));
            let file_start = text.find("name=\"file\"").unwrap();
            assert!(file_start > text.find("name=\"overwrite\"").unwrap());
            assert!(
                !text[file_start + 1..].contains("content-disposition: form-data; name=\""),
                "file must be the final part"
            );
            // The UTF-8 file name and binary payload survive the same streaming code used in production.
            assert!(text.contains("filename=\"中文 archive.rar\""));
            let header_end = body
                .windows(4)
                .enumerate()
                .filter(|(i, _)| *i > file_start)
                .find(|(_, v)| *v == b"\r\n\r\n")
                .unwrap()
                .0
                + 4;
            assert_eq!(
                &body[header_end..header_end + payloads[index].len()],
                &payloads[index]
            );
        }
    }

    #[tokio::test]
    async fn reveal_missing_download_reports_actionable_error() {
        let path = std::env::temp_dir().join(format!("filedesk-missing-{}", uuid::Uuid::new_v4()));
        assert!(reveal_download(path.to_string_lossy().into_owned())
            .await
            .unwrap_err()
            .contains("已被移动或删除"));
    }
}
