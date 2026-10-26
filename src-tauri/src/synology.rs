use crate::{Account, Result};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::time::Duration;
#[derive(Clone)]
pub struct Session {
    pub client: Client,
    pub base: String,
    pub sid: String,
    pub apis: Value,
}
pub fn decode(v: Value) -> Result<Value> {
    if v["success"] == true {
        return Ok(v.get("data").cloned().unwrap_or(json!({})));
    }
    let code = v["error"]["code"].as_i64().unwrap_or(-1);
    let reason = match code {
        400 => "请求参数无效或账号密码错误",
        401 => "账号停用或不允许此操作",
        402 => "权限不足",
        403 => "权限不足或需要双重验证",
        404 => "文件不存在或验证失败",
        406 => "需要双重验证码，请填写动态验证码",
        407 => "验证码不正确",
        408 => "验证码已过期",
        105 => "权限不足",
        106 | 107 => "会话已过期，请重新连接",
        119 => "会话 ID 未找到或无效，请重新连接",
        414 => "文件已存在",
        _ => "群晖拒绝了请求",
    };
    Err(format!("{reason}（DSM {code}）"))
}
pub fn normalize_address(s: &str) -> Result<String> {
    let s = s.trim().trim_end_matches('/');
    let value = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&value).map_err(|_| "地址格式不正确")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请填写 HTTP/HTTPS 地址，不要在地址内包含密码或查询参数".into());
    }
    Ok(value)
}
fn client(insecure: bool) -> Result<Client> {
    Client::builder()
        .danger_accept_invalid_certs(insecure)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}
async fn discover(c: &Client, base: &str) -> Result<Value> {
    let r = c
        .get(format!("{base}/webapi/query.cgi"))
        .query(&[
            ("api", "SYNO.API.Info"),
            ("version", "1"),
            ("method", "query"),
            ("query", "all"),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(network)?;
    decode(
        r.error_for_status()
            .map_err(network)?
            .json()
            .await
            .map_err(network)?,
    )
}
pub fn network(e: reqwest::Error) -> String {
    format!(
        "网络请求失败，请检查地址、端口、证书及 NAS 状态：{}",
        e.without_url()
    )
}
pub async fn login(a: &Account, password: &str, otp: &str) -> Result<Session> {
    let c = client(a.insecure)?;
    let base = if a.mode == "quickconnect" {
        match quickconnect(&c, &a.address).await {
            Ok(url) => url,
            Err(e) => {
                if a.fallback.trim().is_empty() {
                    return Err(e);
                }
                normalize_address(&a.fallback)?
            }
        }
    } else {
        normalize_address(&a.address)?
    };
    let apis = discover(&c, &base).await?;
    let mut s = Session {
        client: c,
        base,
        sid: String::new(),
        apis,
    };
    let mut p = vec![
        ("account", a.username.clone()),
        ("passwd", password.to_string()),
        ("session", "FileStation".into()),
        ("format", "sid".into()),
    ];
    if !otp.is_empty() {
        p.push(("otp_code", otp.into()));
    }
    let data = s.call("SYNO.API.Auth", "login", p).await?;
    s.sid = data["sid"].as_str().ok_or("DSM 未返回会话 ID")?.into();
    Ok(s)
}
impl Session {
    pub fn endpoint(&self, api: &str) -> Result<(String, u64)> {
        let item = &self.apis[api];
        let path = item["path"]
            .as_str()
            .ok_or_else(|| format!("NAS 不支持 {api}，请确认安装并启用了 File Station"))?;
        if path.contains(":") || path.starts_with('/') || path.contains("..") {
            return Err("无效的 API 路径".into());
        }
        let desired = match api {
            "SYNO.API.Auth" => 6,
            "SYNO.FileStation.CopyMove" => 3,
            _ => 2,
        };
        let version = item["maxVersion"].as_u64().unwrap_or(1).min(desired);
        if version < item["minVersion"].as_u64().unwrap_or(1) {
            return Err(format!("不支持的 API 版本：{api}"));
        }
        Ok((format!("{}/webapi/{path}", self.base), version))
    }
    pub async fn call(
        &self,
        api: &str,
        method: &str,
        mut params: Vec<(&str, String)>,
    ) -> Result<Value> {
        let (url, ver) = self.endpoint(api)?;
        params.extend([
            ("api", api.into()),
            ("version", ver.to_string()),
            ("method", method.into()),
        ]);
        if !self.sid.is_empty() {
            params.push(("_sid", self.sid.clone()));
        }
        let r = self
            .client
            .post(url)
            .form(&params)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(network)?
            .error_for_status()
            .map_err(network)?;
        decode(r.json().await.map_err(network)?)
    }
    pub async fn list(&self, path: &str) -> Result<Value> {
        let mut all = Vec::new();
        let mut offset = 0;
        loop {
            let mut p = vec![
                ("additional", r#"["size","time","type","perm"]"#.into()),
                ("offset", offset.to_string()),
                ("limit", "1000".into()),
                ("sort_by", "name".into()),
                ("sort_direction", "asc".into()),
            ];
            if path != "/" {
                p.push(("folder_path", path.into()));
            }
            let data = self
                .call(
                    "SYNO.FileStation.List",
                    if path == "/" { "list_share" } else { "list" },
                    p,
                )
                .await?;
            let items = data[if path == "/" { "shares" } else { "files" }]
                .as_array()
                .ok_or("无效的目录响应")?;
            all.extend(items.iter().cloned());
            offset += items.len();
            if items.is_empty()
                || offset >= data["total"].as_u64().unwrap_or(offset as u64) as usize
            {
                break;
            }
        }
        Ok(json!(all))
    }
    pub async fn operate(
        &self,
        action: &str,
        paths: Vec<String>,
        destination: String,
        name: String,
    ) -> Result<Value> {
        let encoded = json!(paths).to_string();
        let (api, method, params) = match action {
            "mkdir" => {
                validate_name(&name)?;
                (
                    "SYNO.FileStation.CreateFolder",
                    "create",
                    vec![
                        ("folder_path", json!([destination]).to_string()),
                        ("name", json!([name]).to_string()),
                    ],
                )
            }
            "rename" => {
                validate_name(&name)?;
                if paths.len() != 1 {
                    return Err("请选择一个项目".into());
                }
                (
                    "SYNO.FileStation.Rename",
                    "rename",
                    vec![("path", encoded), ("name", json!([name]).to_string())],
                )
            }
            "delete" => (
                "SYNO.FileStation.Delete",
                "start",
                vec![("path", encoded), ("recursive", "true".into())],
            ),
            "copy" | "move" => (
                "SYNO.FileStation.CopyMove",
                "start",
                vec![
                    ("path", encoded),
                    ("dest_folder_path", destination),
                    ("remove_src", (action == "move").to_string()),
                ],
            ),
            "share" => (
                "SYNO.FileStation.Sharing",
                "create",
                vec![("path", encoded)],
            ),
            _ => return Err("不支持的操作".into()),
        };
        let data = self.call(api, method, params).await?;
        if let Some(task) = data["taskid"].as_str() {
            for _ in 0..600 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let status = self
                    .call(api, "status", vec![("taskid", task.into())])
                    .await?;
                if status["finished"] == true {
                    if status["errors"].as_array().is_some_and(|e| !e.is_empty()) {
                        return Err(format!("NAS 后台任务部分或全部失败：{}", status["errors"]));
                    }
                    return Ok(status);
                }
            }
            return Err(
                "NAS 后台任务仍在执行；请在 File Station 中检查任务结果后刷新，不要重复提交".into(),
            );
        }
        Ok(data)
    }
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        || name.ends_with(['.', ' '])
        || matches!(
            name.split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
    {
        Err("名称为空或不兼容 Windows 文件名规则".into())
    } else {
        Ok(())
    }
}
async fn quickconnect(c: &Client, id: &str) -> Result<String> {
    let id = id.trim();
    if id.is_empty() || !id.chars().all(|v| v.is_ascii_alphanumeric() || v == '-') {
        return Err("请填写 QuickConnect ID，不是网址".into());
    }
    // Discovery never receives DSM usernames, passwords or session tokens.
    let discovery = client(false)?;
    for region in ["to", "cn"] {
        for command in ["get_server_info", "request_tunnel"] {
            let body = json!([{ "version":1,"command":command,"stop_when_error":false,"stop_when_success":false,"id":"dsm_portal_https","serverID":id,"is_gofile":false }]);
            let response = discovery
                .post(format!("https://global.quickconnect.{region}/Serv.php"))
                .json(&body)
                .timeout(Duration::from_secs(12))
                .send()
                .await;
            let Ok(response) = response else { continue };
            let Ok(v) = response.json::<Value>().await else {
                continue;
            };
            let entries = v.as_array().cloned().unwrap_or(vec![v]);
            for item in entries {
                if item["errno"].as_i64() != Some(0) {
                    continue;
                }
                let Some(server_id) = item["server"]["serverID"].as_str() else {
                    continue;
                };
                let expected = format!("{:x}", md5::compute(server_id));
                let candidates = qc_candidates(&item);
                let probes = candidates.into_iter().map(|base| {
                    let c = c.clone();
                    let expected = expected.clone();
                    async move {
                        let r = c
                            .get(format!("{base}/webman/pingpong.cgi"))
                            .query(&[("action", "cors"), ("quickconnect", "true")])
                            .timeout(Duration::from_secs(3))
                            .send()
                            .await
                            .ok()?;
                        let v: Value = r.json().await.ok()?;
                        if v["success"] == true && v["ezid"].as_str() == Some(&expected) {
                            Some(base)
                        } else {
                            None
                        }
                    }
                });
                if let Some(base) = futures_util::future::join_all(probes)
                    .await
                    .into_iter()
                    .flatten()
                    .next()
                {
                    return Ok(base);
                }
            }
        }
    }
    Err("QuickConnect 未找到可验证的 HTTPS 连接。请检查 ID、NAS 在线状态及证书，或填写备用 IP/域名。此连接方式处于实验阶段。".into())
}
fn qc_candidates(v: &Value) -> Vec<String> {
    let port = v["service"]["port"].as_u64().unwrap_or(5001);
    let ext = v["service"]["ext_port"]
        .as_u64()
        .filter(|p| *p > 0)
        .unwrap_or(port);
    let mut hosts: Vec<(String, u64)> = vec![];
    for key in ["lan", "lanv6"] {
        if let Some(items) = v["smartdns"][key].as_array() {
            for h in items {
                if let Some(h) = h.as_str() {
                    hosts.push((h.into(), port));
                }
            }
        }
    }
    if let Some(items) = v["server"]["interface"].as_array() {
        for h in items {
            if let Some(h) = h["ip"].as_str() {
                hosts.push((h.into(), port));
            }
        }
    }
    for h in [
        &v["server"]["fqdn"],
        &v["server"]["ddns"],
        &v["smartdns"]["host"],
        &v["server"]["external"]["ip"],
    ] {
        if let Some(h) = h.as_str() {
            hosts.push((h.into(), ext));
        }
    }
    if let Some(p) = v["service"]["relay_port"].as_u64() {
        for key in ["relay_dn", "relay_ip", "relay_ipv6"] {
            if let Some(h) = v["service"][key].as_str() {
                hosts.push((h.into(), p));
            }
        }
    }
    hosts
        .into_iter()
        .filter(|(h, p)| {
            !h.is_empty()
                && h != "NULL"
                && *p > 0
                && *p <= 65535
                && !h.contains(['/', '@', '?', '#'])
        })
        .map(|(h, p)| {
            format!(
                "https://{}:{p}",
                if h.contains(':') { format!("[{h}]") } else { h }
            )
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_reject_credentials_and_bad_schemes() {
        assert!(normalize_address("https://user:secret@nas").is_err());
        assert!(normalize_address("file:///C:/").is_err());
        assert_eq!(
            normalize_address("nas.local:5001/").unwrap(),
            "https://nas.local:5001"
        );
    }
    #[test]
    fn expired_sessions_are_explicit() {
        assert!(decode(json!({"success":false,"error":{"code":119}}))
            .unwrap_err()
            .contains("重新连接"));
    }
    #[test]
    fn filenames_cannot_escape_directory() {
        for n in ["..", "a/b", "a\\b", ""] {
            assert!(validate_name(n).is_err());
        }
        assert!(validate_name("剧集 01.mkv").is_ok());
    }
    #[test]
    fn discovery_prefers_lan_and_tls() {
        let v = json!({"service":{"port":5001,"ext_port":6001},"server":{"interface":[{"ip":"192.168.1.3"}],"external":{"ip":"1.2.3.4"}}});
        assert_eq!(
            qc_candidates(&v),
            vec!["https://192.168.1.3:5001", "https://1.2.3.4:6001"]
        );
    }
    #[tokio::test]
    async fn mock_dsm_discovers_authenticates_paginates_and_encodes_unicode() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let responses = vec![
                json!({"success":true,"data":{
                    "SYNO.API.Auth":{"path":"auth.cgi","minVersion":1,"maxVersion":7},
                    "SYNO.FileStation.List":{"path":"entry.cgi","minVersion":1,"maxVersion":2},
                    "SYNO.FileStation.Rename":{"path":"entry.cgi","minVersion":1,"maxVersion":2}
                }}),
                json!({"success":true,"data":{"sid":"test-session-only"}}),
                json!({"success":true,"data":{"total":2,"files":[{"name":"甲.txt","path":"/home/甲.txt","isdir":false}]}}),
                json!({"success":true,"data":{"total":2,"files":[{"name":"乙.txt","path":"/home/乙.txt","isdir":false}]}}),
                json!({"success":true,"data":{}}),
            ];
            let mut requests = vec![];
            for response in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                let mut chunk = [0u8; 4096];
                loop {
                    let n = socket.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|s| {
                                s.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = response.to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            requests
        });
        let a = Account {
            id: "test".into(),
            name: "test".into(),
            address,
            username: "tester".into(),
            mode: "direct".into(),
            fallback: String::new(),
            insecure: false,
            remember: false,
        };
        let session = login(&a, "synthetic-test-password", "123456")
            .await
            .unwrap();
        let entries = session.list("/home").await.unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 2);
        session
            .operate(
                "rename",
                vec!["/home/甲.txt".into()],
                String::new(),
                "新名字.txt".into(),
            )
            .await
            .unwrap();
        let reqs = worker.join().unwrap();
        assert!(reqs[0].starts_with("GET /webapi/query.cgi?"));
        assert!(reqs[1].starts_with("POST /webapi/auth.cgi"));
        assert!(!reqs[1].lines().next().unwrap().contains("password"));
        assert!(reqs[1].contains("version=6"));
        assert!(reqs[1].contains("otp_code=123456"));
        assert!(reqs[2].contains("_sid=test-session-only"));
        assert!(reqs[3].contains("offset=1"));
        let body = reqs[4].split("\r\n\r\n").nth(1).unwrap();
        let fields: std::collections::HashMap<_, _> =
            reqwest::Url::parse(&format!("http://test/?{body}"))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
        assert_eq!(fields["name"], json!(["新名字.txt"]).to_string());
    }
}
