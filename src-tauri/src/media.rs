use crate::synology::{decode, network, Session};
use crate::{session, AppState, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::Serialize;
use std::{sync::OnceLock, time::Duration};
use tauri::State;
use tokio::sync::Semaphore;

static MEDIA_SLOTS: OnceLock<Semaphore> = OnceLock::new();
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    data_url: String,
    original: bool,
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}

async fn fetch(s: &Session, path: &str, original: bool, preview: bool) -> Result<Media> {
    let api = if original {
        "SYNO.FileStation.Download"
    } else {
        "SYNO.FileStation.Thumb"
    };
    let (url, version) = s.endpoint(api)?;
    let mut params = vec![
        ("api", api.to_owned()),
        ("version", version.to_string()),
        ("method", if original { "download" } else { "get" }.into()),
        ("_sid", s.sid.clone()),
        (
            "path",
            if original {
                serde_json::json!([path]).to_string()
            } else {
                serde_json::json!(path).to_string()
            },
        ),
    ];
    if original {
        params.push(("mode", "open".into()));
    } else {
        params.push(("size", if preview { "large" } else { "medium" }.into()));
    }
    let response = s
        .client
        .get(url)
        .query(&params)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(network)?
        .error_for_status()
        .map_err(network)?;
    let limit = if original {
        32 * 1024 * 1024
    } else {
        2 * 1024 * 1024
    };
    if response.content_length().is_some_and(|n| n > limit) {
        return Err("图片过大，原图预览上限为 32 MB".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network)?;
        if bytes.len() + chunk.len() > limit as usize {
            return Err("图片超过预览大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mime = match image_mime(&bytes) {
        Some(mime) => mime,
        None => {
            if let Ok(json) = serde_json::from_slice(&bytes) {
                decode(json)?;
            }
            return Err("NAS 未生成缩略图，或图片格式无法预览".into());
        }
    };
    Ok(Media {
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        original,
    })
}

#[tauri::command]
pub async fn load_media(
    state: State<'_, AppState>,
    id: String,
    path: String,
    preview: bool,
) -> Result<Media> {
    let s = session(&state, &id)?;
    let _permit = MEDIA_SLOTS
        .get_or_init(|| Semaphore::new(4))
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if preview
        && matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "jpe" | "png" | "gif" | "webp" | "bmp" | "avif"
        )
    {
        match fetch(&s, &path, true, true).await {
            Ok(media) => Ok(media),
            Err(original_error) => fetch(&s, &path, false, true)
                .await
                .map_err(|_| original_error),
        }
    } else {
        fetch(&s, &path, false, preview).await
    }
}

#[tauri::command]
pub fn set_appearance(window: tauri::WebviewWindow, dark: bool) -> Result<()> {
    window
        .set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use tauri::window::{Effect, EffectsBuilder};
        // Acrylic is a native backdrop; CSS supplies a readable translucent fallback.
        window
            .set_effects(
                EffectsBuilder::new()
                    .effect(Effect::Acrylic)
                    .color(if dark {
                        (25, 25, 25, 210).into()
                    } else {
                        (243, 243, 243, 215).into()
                    })
                    .build(),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn thumbnail_protocol_validates_payload_size_and_api_errors() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let bodies: Vec<(Vec<u8>, usize)> = vec![
                (b"\xff\xd8\xff\xe0".to_vec(), 4),
                (br#"{"success":false,"error":{"code":119}}"#.to_vec(), 0),
                (vec![], 40 * 1024 * 1024),
            ];
            let mut requests = vec![];
            for (body, declared) in bodies {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                }
                requests.push(String::from_utf8(request).unwrap());
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",if declared==0 {body.len()} else {declared}).unwrap();
                socket.write_all(&body).unwrap();
            }
            requests
        });
        let s = Session {
            client: reqwest::Client::new(),
            base,
            sid: "test-session".into(),
            apis: serde_json::json!({"SYNO.FileStation.Thumb":{"path":"entry.cgi","minVersion":1,"maxVersion":2}}),
        };
        let media = fetch(&s, "/photo/中文.jpg", false, false).await.unwrap();
        assert!(media.data_url.starts_with("data:image/jpeg;base64,"));
        assert!(!media.original);
        assert!(fetch(&s, "/photo/missing.jpg", false, false)
            .await
            .err()
            .unwrap()
            .contains("重新连接"));
        assert!(fetch(&s, "/photo/huge.jpg", false, false)
            .await
            .err()
            .unwrap()
            .contains("过大"));
        let requests = worker.join().unwrap();
        let target = requests[0]
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let fields: std::collections::HashMap<_, _> =
            reqwest::Url::parse(&format!("http://test{target}"))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
        assert_eq!(fields["path"], "\"/photo/中文.jpg\"");
        assert_eq!(fields["size"], "medium");
        assert_eq!(fields["_sid"], "test-session");
    }
    #[test]
    fn media_signature_rejects_html_svg_and_dsm_errors() {
        for b in [
            b"<svg></svg>".as_slice(),
            b"<html>login</html>",
            br#"{"success":false}"#,
        ] {
            assert!(image_mime(b).is_none());
        }
        assert_eq!(image_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(image_mime(b"RIFFabcdWEBP"), Some("image/webp"));
        assert!(image_mime(b"RIFFabcdWAVE").is_none());
    }
}
