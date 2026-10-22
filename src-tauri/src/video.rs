//! LibVLC 3 ABI, dynamically linked so the decoder remains replaceable.
use crate::{session, AppState, Result};
use axum::{
    body::Body,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use futures_util::StreamExt;
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_int, c_void, CString},
    sync::Mutex,
};
use tauri::{Manager, State};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stream_proxy_forwards_ranges_hides_credentials_and_revokes() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", upstream.local_addr().unwrap());
        let router = Router::new().route(
            "/webapi/entry.cgi",
            get(
                |headers: HeaderMap,
                 axum::extract::Query(q): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >| async move {
                    assert_eq!(headers.get("range").unwrap(), "bytes=2-5");
                    assert_eq!(q["_sid"], "secret-test");
                    assert_eq!(q["path"], "[\"/video/中文.mkv\"]");
                    Response::builder()
                        .status(206)
                        .header("content-range", "bytes 2-5/10")
                        .header("accept-ranges", "bytes")
                        .header("content-type", "video/x-matroska")
                        .body(Body::from("2345"))
                        .unwrap()
                },
            ),
        );
        let server = tokio::spawn(async move {
            axum::serve(upstream, router).await.unwrap();
        });
        let s = crate::synology::Session {
            client: reqwest::Client::new(),
            base,
            sid: "secret-test".into(),
            apis: serde_json::json!({"SYNO.FileStation.Download":{"path":"entry.cgi","minVersion":1,"maxVersion":2}}),
        };
        let cancel = CancellationToken::new();
        let (url, proxy_server) = proxy(s, "/video/中文.mkv".into(), cancel.clone())
            .await
            .unwrap();
        assert!(!url.contains("secret-test"));
        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header("range", "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(response.bytes().await.unwrap(), "2345");
        let wrong = format!("{}/wrong", url.rsplit_once('/').unwrap().0);
        assert_eq!(client.get(wrong).send().await.unwrap().status(), 404);
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), proxy_server)
            .await
            .unwrap()
            .unwrap();
        assert!(client.get(&url).send().await.is_err());
        server.abort();
    }
}

#[derive(Default)]
pub struct VideoState(Mutex<Option<Player>>, tokio::sync::Mutex<()>);
struct Player {
    lib: Library,
    instance: *mut c_void,
    player: *mut c_void,
    child: usize,
    app: tauri::AppHandle,
    cancel: CancellationToken,
    server: tokio::task::JoinHandle<()>,
    owner: String,
}
// All LibVLC calls are serialized by VideoState. HWND work is dispatched to the UI thread.
unsafe impl Send for Player {}
impl Player {
    unsafe fn symbol<T: Copy>(&self, name: &[u8]) -> T {
        *self.lib.get::<T>(name).expect("validated LibVLC ABI")
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            self.cancel.cancel();
            self.server.abort();
            self.symbol::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_media_player_stop\0")(
                self.player,
            );
            self.symbol::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_media_player_release\0")(
                self.player,
            );
            self.symbol::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_release\0")(self.instance);
            let child = self.child;
            let _ = self.app.run_on_main_thread(move || {
                #[cfg(windows)]
                {
                    DestroyWindow(child as *mut c_void);
                }
            });
        }
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: *mut c_void,
        menu: *mut c_void,
        instance: *mut c_void,
        param: *mut c_void,
    ) -> *mut c_void;
    fn SetWindowPos(
        hwnd: *mut c_void,
        after: *mut c_void,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        flags: u32,
    ) -> i32;
    fn DestroyWindow(hwnd: *mut c_void) -> i32;
}
#[derive(Clone, Copy, Deserialize)]
pub struct Bounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
#[derive(Serialize)]
pub struct Status {
    time: i64,
    duration: i64,
    playing: bool,
    state: i32,
    seekable: bool,
}

async fn proxy(
    s: crate::synology::Session,
    path: String,
    cancel: CancellationToken,
) -> Result<(String, tokio::task::JoinHandle<()>)> {
    let (endpoint, version) = s.endpoint("SYNO.FileStation.Download")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().to_string();
    let route = format!("/{token}");
    let shutdown = cancel.clone();
    let app = Router::new().route(
        &route,
        get(move |headers: HeaderMap| {
            let (s, path, endpoint, cancel) =
                (s.clone(), path.clone(), endpoint.clone(), cancel.clone());
            async move {
                if cancel.is_cancelled() {
                    return Response::builder().status(410).body(Body::empty()).unwrap();
                }
                let mut request = s.client.get(endpoint).query(&[
                    ("api", "SYNO.FileStation.Download".to_owned()),
                    ("version", version.to_string()),
                    ("method", "download".into()),
                    ("path", serde_json::json!([path]).to_string()),
                    ("mode", "open".into()),
                    ("_sid", s.sid.clone()),
                ]);
                if let Some(range) = headers.get("range") {
                    request = request.header("range", range);
                }
                let received = tokio::select! {
                    _ = cancel.cancelled() => return Response::builder().status(410).body(Body::empty()).unwrap(),
                    result = request.send() => result,
                };
                let response = match received {
                    Ok(r) => r,
                    Err(_) => return Response::builder().status(502).body(Body::empty()).unwrap(),
                };
                let status = response.status();
                // DSM may return an authentication error as JSON with HTTP 200.
                if response
                    .headers()
                    .get("content-type")
                    .is_some_and(|v| v.to_str().unwrap_or("").contains("json"))
                {
                    return Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .body(Body::empty())
                        .unwrap();
                }
                let mut out = Response::builder().status(status);
                for name in [
                    "content-type",
                    "content-length",
                    "content-range",
                    "accept-ranges",
                ] {
                    if let Some(value) = response.headers().get(name) {
                        out = out.header(name, value);
                    }
                }
                out.body(Body::from_stream(
                    response.bytes_stream().take_until(cancel.cancelled_owned()),
                ))
                .unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await;
    });
    Ok((format!("http://127.0.0.1:{port}/{token}"), server))
}

#[tauri::command]
pub async fn video_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    video: State<'_, VideoState>,
    id: String,
    path: String,
    bounds: Bounds,
    owner: String,
) -> Result<()> {
    let _gate = video.1.lock().await;
    video.0.lock().unwrap().take();
    let cancel = CancellationToken::new();
    let (url, server) = proxy(session(&state, &id)?, path, cancel.clone()).await?;
    let child_cancel = cancel.clone();
    let result = tokio::task::spawn_blocking(move || {
        start(app, window, bounds, url, child_cancel, server, owner)
    })
    .await
    .map_err(|_| "播放器初始化任务失败".to_owned())?;
    match result {
        Ok(player) => {
            *video.0.lock().unwrap() = Some(player);
            Ok(())
        }
        Err(e) => {
            cancel.cancel();
            Err(e)
        }
    }
}

fn start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    b: Bounds,
    url: String,
    cancel: CancellationToken,
    server: tokio::task::JoinHandle<()>,
    owner: String,
) -> Result<Player> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let candidates = [
        exe.parent().unwrap().join("decoder"),
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("decoder"),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("decoder"),
    ];
    let folder = candidates
        .into_iter()
        .find(|p| p.join("libvlc.dll").exists())
        .ok_or("未找到 LibVLC 解码器。请将完整 decoder 文件夹与 FileDesk.exe 放在一起。")?;
    #[cfg(not(windows))]
    {
        let _ = (window, b, url, cancel, server, owner, folder);
        return Err("当前播放器仅实现 Windows，macOS 后续适配".into());
    }
    #[cfg(windows)]
    unsafe {
        // LOAD_WITH_ALTERED_SEARCH_PATH resolves libvlccore beside the specified DLL.
        let lib: Library =
            libloading::os::windows::Library::load_with_flags(folder.join("libvlc.dll"), 8)
                .map_err(|e| format!("无法加载解码器：{e}"))?
                .into();
        for name in [
            "libvlc_new",
            "libvlc_release",
            "libvlc_media_new_location",
            "libvlc_media_release",
            "libvlc_media_player_new_from_media",
            "libvlc_media_player_release",
            "libvlc_media_player_stop",
            "libvlc_media_player_play",
            "libvlc_media_player_set_hwnd",
            "libvlc_media_player_set_pause",
            "libvlc_media_player_set_time",
            "libvlc_media_player_get_time",
            "libvlc_media_player_get_length",
            "libvlc_media_player_is_playing",
            "libvlc_media_player_get_state",
            "libvlc_media_player_is_seekable",
            "libvlc_audio_set_volume",
            "libvlc_video_set_mouse_input",
            "libvlc_video_set_key_input",
        ] {
            lib.get::<*const c_void>(format!("{name}\0").as_bytes())
                .map_err(|_| "LibVLC 版本不兼容")?;
        }
        let args = [
            CString::new("--no-video-title-show").unwrap(),
            CString::new("--no-snapshot-preview").unwrap(),
            CString::new("--quiet").unwrap(),
            CString::new("--network-caching=1000").unwrap(),
        ];
        let pointers: Vec<_> = args.iter().map(|s| s.as_ptr()).collect();
        let instance = lib
            .get::<unsafe extern "C" fn(c_int, *const *const c_char) -> *mut c_void>(
                b"libvlc_new\0",
            )
            .unwrap()(pointers.len() as i32, pointers.as_ptr());
        if instance.is_null() {
            return Err("解码器初始化失败，请检查 decoder/plugins 是否完整".into());
        }
        let location = CString::new(url).map_err(|_| "播放地址无效")?;
        let media = lib
            .get::<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>(
                b"libvlc_media_new_location\0",
            )
            .unwrap()(instance, location.as_ptr());
        let player = if media.is_null() {
            std::ptr::null_mut()
        } else {
            lib.get::<unsafe extern "C" fn(*mut c_void) -> *mut c_void>(
                b"libvlc_media_player_new_from_media\0",
            )
            .unwrap()(media)
        };
        if !media.is_null() {
            lib.get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_media_release\0")
                .unwrap()(media);
        }
        if player.is_null() {
            lib.get::<unsafe extern "C" fn(*mut c_void)>(b"libvlc_release\0")
                .unwrap()(instance);
            return Err("无法创建播放器".into());
        }
        let mut p = Player {
            lib,
            instance,
            player,
            child: 0,
            app: app.clone(),
            cancel,
            server,
            owner,
        };
        let parent = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let child = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0x56000000,
                b.x,
                b.y,
                b.width.max(1),
                b.height.max(1),
                parent as *mut c_void,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            let _ = tx.send(child as usize);
        })
        .map_err(|e| e.to_string())?;
        p.child = rx.blocking_recv().map_err(|e| e.to_string())?;
        if p.child == 0 {
            return Err("无法创建视频画面窗口".into());
        }
        p.symbol::<unsafe extern "C" fn(*mut c_void, *mut c_void)>(
            b"libvlc_media_player_set_hwnd\0",
        )(player, p.child as *mut c_void);
        p.symbol::<unsafe extern "C" fn(*mut c_void, u32)>(b"libvlc_video_set_mouse_input\0")(
            player, 0,
        );
        p.symbol::<unsafe extern "C" fn(*mut c_void, u32)>(b"libvlc_video_set_key_input\0")(
            player, 0,
        );
        if p.symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(b"libvlc_media_player_play\0")(
            player,
        ) != 0
        {
            return Err("无法开始播放".into());
        }
        Ok(p)
    }
}

#[tauri::command]
pub async fn video_command(
    app: tauri::AppHandle,
    state: State<'_, VideoState>,
    owner: String,
    action: String,
    value: Option<f64>,
    bounds: Option<Bounds>,
) -> Result<Option<Status>> {
    let _gate = state.1.lock().await;
    let mut guard = state.0.lock().unwrap();
    let Some(p) = guard.as_ref() else {
        return Ok(None);
    };
    if p.owner != owner {
        return Ok(None);
    }
    if action == "close" {
        guard.take();
        return Ok(None);
    }
    unsafe {
        match action.as_str() {
            "pause" => {
                let pause = value.unwrap_or(1.) as i32;
                let ended = p.symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(
                    b"libvlc_media_player_get_state\0",
                )(p.player)
                    == 6;
                if pause == 0 && ended {
                    p.symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(
                        b"libvlc_media_player_play\0",
                    )(p.player);
                } else {
                    p.symbol::<unsafe extern "C" fn(*mut c_void, i32)>(
                        b"libvlc_media_player_set_pause\0",
                    )(p.player, pause);
                }
            }
            "seek" => p.symbol::<unsafe extern "C" fn(*mut c_void, i64)>(
                b"libvlc_media_player_set_time\0",
            )(p.player, value.unwrap_or(0.).max(0.) as i64),
            "volume" => {
                p.symbol::<unsafe extern "C" fn(*mut c_void, i32) -> i32>(
                    b"libvlc_audio_set_volume\0",
                )(p.player, value.unwrap_or(80.).clamp(0., 100.) as i32);
            }
            "bounds" => {
                if let Some(b) = bounds {
                    let child = p.child;
                    app.run_on_main_thread(move || {
                        #[cfg(windows)]
                        {
                            SetWindowPos(
                                child as *mut c_void,
                                std::ptr::null_mut(),
                                b.x,
                                b.y,
                                b.width.max(1),
                                b.height.max(1),
                                0x0010,
                            );
                        }
                    })
                    .map_err(|e| e.to_string())?;
                }
            }
            "status" => (),
            _ => return Err("未知播放操作".into()),
        }
        Ok(Some(Status {
            time: p.symbol::<unsafe extern "C" fn(*mut c_void) -> i64>(
                b"libvlc_media_player_get_time\0",
            )(p.player),
            duration: p.symbol::<unsafe extern "C" fn(*mut c_void) -> i64>(
                b"libvlc_media_player_get_length\0",
            )(p.player),
            playing: p.symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(
                b"libvlc_media_player_is_playing\0",
            )(p.player)
                != 0,
            state: p.symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(
                b"libvlc_media_player_get_state\0",
            )(p.player),
            seekable: p.symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(
                b"libvlc_media_player_is_seekable\0",
            )(p.player)
                != 0,
        }))
    }
}
