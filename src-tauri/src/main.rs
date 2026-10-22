#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod media;
mod synology;
mod transfer;
mod video;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use synology::Session;
use tauri::{Manager, State};

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    id: String,
    name: String,
    address: String,
    username: String,
    mode: String,
    #[serde(default)]
    fallback: String,
    #[serde(default)]
    insecure: bool,
    #[serde(default)]
    remember: bool,
}
#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, Session>>,
    cancellations: Mutex<HashMap<String, Arc<tokio_util::sync::CancellationToken>>>,
    accounts_lock: Mutex<()>,
}
fn accounts_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("accounts.json"))
}
fn load_accounts(app: &tauri::AppHandle) -> Result<Vec<Account>> {
    let path = accounts_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn store_accounts(app: &tauri::AppHandle, items: &[Account]) -> Result<()> {
    let path = accounts_path(app)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
#[tauri::command]
fn accounts(app: tauri::AppHandle, state: State<AppState>) -> Result<Vec<Account>> {
    let _guard = state.accounts_lock.lock().unwrap();
    load_accounts(&app)
}
#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut account: Account,
    password: String,
    otp: String,
) -> Result<String> {
    if account.id.is_empty() {
        account.id = uuid::Uuid::new_v4().to_string();
    }
    if account.name.trim().is_empty() || account.username.trim().is_empty() {
        return Err("请填写名称和用户名".into());
    }
    let entry = keyring::Entry::new("FileDesk", &account.id).map_err(|e| e.to_string())?;
    let secret = if password.is_empty() {
        entry
            .get_password()
            .map_err(|_| "请输入密码，未找到已保存的凭据")?
    } else {
        password
    };
    let session = synology::login(&account, &secret, &otp).await?;
    if account.remember {
        entry
            .set_password(&secret)
            .map_err(|e| format!("凭据保存失败：{e}"))?;
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    {
        let _guard = state.accounts_lock.lock().unwrap();
        let mut items = load_accounts(&app)?;
        items.retain(|a| a.id != account.id);
        items.push(account.clone());
        store_accounts(&app, &items)?;
    }
    state
        .sessions
        .lock()
        .unwrap()
        .insert(account.id.clone(), session);
    Ok(account.id)
}
#[tauri::command]
async fn disconnect(state: State<'_, AppState>, id: String) -> Result<()> {
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some(s) = session {
        s.call(
            "SYNO.API.Auth",
            "logout",
            vec![("session", "FileStation".into())],
        )
        .await?;
    }
    Ok(())
}
#[tauri::command]
fn remove_account(app: tauri::AppHandle, state: State<AppState>, id: String) -> Result<()> {
    let _guard = state.accounts_lock.lock().unwrap();
    let entry = keyring::Entry::new("FileDesk", &id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => (),
        Err(e) => return Err(e.to_string()),
    }
    let mut items = load_accounts(&app)?;
    items.retain(|a| a.id != id);
    store_accounts(&app, &items)?;
    state.sessions.lock().unwrap().remove(&id);
    Ok(())
}
pub fn session(state: &AppState, id: &str) -> Result<Session> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or("请先连接此账号".into())
}
#[tauri::command]
async fn list_files(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<serde_json::Value> {
    session(&state, &id)?.list(&path).await
}
#[tauri::command]
async fn operate(
    state: State<'_, AppState>,
    id: String,
    action: String,
    paths: Vec<String>,
    destination: String,
    name: String,
) -> Result<serde_json::Value> {
    session(&state, &id)?
        .operate(&action, paths, destination, name)
        .await
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(video::VideoState::default())
        .invoke_handler(tauri::generate_handler![
            accounts,
            connect,
            disconnect,
            remove_account,
            list_files,
            operate,
            transfer::upload,
            transfer::download,
            transfer::cancel_transfer,
            transfer::prepare_drag,
            transfer::native_drag,
            media::load_media,
            media::set_appearance,
            video::video_open,
            video::video_command
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 FileDesk");
}
