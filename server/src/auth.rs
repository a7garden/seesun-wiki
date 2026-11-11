// 계정 · 로그인 · MCP 토큰.
// 계정은 data/users.json 한 장이다. 사내 수십 명 규모라 DB 를 두지 않는다.
// 2026.11.09 : Node 판과 같은 파일 · 같은 해시(scrypt N=16384 r=8 p=1 · 64바이트) · 같은 쿠키 서명을 쓴다.
//              그래서 판을 바꿔도 계정 · 토큰 · 로그인이 그대로 이어진다.
// 2026.11.09 : 이름 · 이메일을 받지 않는다. 화면 · 이력에는 계정마다 하나인 해시(tag)만 보인다.
//              선임이 쓴 글을 후임이 고칠 때 눈치 보지 않도록 고친 사람을 드러내지 않는다. 대신 소속(org)만 받는다.
//              옛 계정의 name · email 칸은 rest 에 그대로 남는다(지우지 않음 · 화면에 내지 않음).
//
// 계정 파일 다루기 (2026.11.09 리뷰 반영)
//   - 읽기 · 쓰기 모두 LOCK 하나로 세운다. 요청이 여러 스레드에서 오므로, 쓰는 도중의 반쪽 파일을 읽으면 「계정 없음」으로 보여
//     막아 둔 가입이 열리고 로그인이 풀렸다(시험에서 8초에 40여 계정이 생김).
//   - 쓰기는 임시 파일에 쓰고 이름을 바꾼다. 쓰다가 꺼져도 옛 파일이 남는다.
//   - 파일이 깨졌으면 빈 목록으로 보지 않고 실패한다. 빈 목록으로 보면 다음 가입자가 관리자가 되고 모든 계정을 덮는다.
//
// 목차 : 계정 파일(load · save) · 가입 설정 · 소속 · 해시 · 계정(가입 · 비밀번호 · 소속 · 권한 · 확인) · 세션 쿠키 · MCP 토큰
use crate::config;
use crate::error::{HttpError, http};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::sync::{LazyLock, Mutex, MutexGuard};
use subtle::ConstantTimeEq;

static ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{1,31}$").unwrap());
static LOCK: Mutex<()> = Mutex::new(());

/// 잠금. 다른 스레드가 잠근 채 패닉해도 계속 쓴다 — 파일은 이름 바꾸기로만 바뀌어 반쪽 상태가 없다.
fn guard() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize, Clone)]
struct Token {
    id: String,
    label: String,
    hash: String,
    created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    used: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Account {
    id: String,
    #[serde(default)]
    org: String,
    role: String,
    salt: String,
    hash: String,
    #[serde(default)]
    tokens: Vec<Token>,
    #[serde(flatten)]
    rest: Map<String, Value>, // created 등 이 판이 모르는 칸도 지우지 않고 그대로 둔다
}

#[derive(Serialize, Deserialize, Default)]
struct Db {
    users: Vec<Account>,
    #[serde(flatten)]
    rest: Map<String, Value>,
}

#[derive(Serialize, Clone, Debug)]
pub struct User {
    pub id: String,
    pub tag: String, // 화면 · 이력에 보이는 이름 대신의 해시
    pub org: String,
    pub role: String,
}

fn pub_user(u: &Account) -> User {
    User { id: u.id.clone(), tag: tag(&u.id), org: u.org.clone(), role: u.role.clone() }
}

fn broken() -> HttpError {
    http(500, "계정 파일(data/users.json)을 읽지 못했습니다. 서버 관리자에게 알려 주세요")
}

/// 계정 파일. 없으면 빈 목록(처음 켠 위키), 깨졌으면 Err. 잠금을 잡은 채로 부른다.
fn load(_g: &MutexGuard<'static, ()>) -> Result<Db, HttpError> {
    match fs::read_to_string(&config::get().users_file) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| {
            eprintln!("계정 파일을 읽지 못함 : {e}");
            broken()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Db::default()),
        Err(e) => {
            eprintln!("계정 파일을 열지 못함 : {e}");
            Err(broken())
        }
    }
}

fn save(_g: &MutexGuard<'static, ()>, db: &Db) -> Result<(), HttpError> {
    let c = config::get();
    let tmp = c.users_file.with_extension("json.tmp");
    let write = || -> std::io::Result<()> {
        fs::create_dir_all(&c.data_dir)?;
        fs::write(&tmp, serde_json::to_string_pretty(db).unwrap())?;
        fs::rename(&tmp, &c.users_file) // 같은 폴더 안 이름 바꾸기 : 읽는 쪽은 옛 파일이나 새 파일 하나만 본다
    };
    write().map_err(|e| {
        eprintln!("계정 파일을 쓰지 못함 : {e}");
        http(500, "계정 파일을 쓰지 못했습니다. 잠시 뒤 다시 해 주세요")
    })
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("난수");
    b
}

// ── 가입 설정
// 2026.11.09 : 소속 목록은 회사 누리집 「오시는 길」의 사업장 넷이다. 바뀌면 data/settings.json 의 orgs 를 고친다.
const ORGS: [&str; 4] = ["김해본사", "서울본부", "대전본부", "부산본부"];

pub fn settings() -> Value {
    let mut s = serde_json::json!({ "openSignup": true, "orgs": ORGS });
    if let Some(Value::Object(f)) = fs::read_to_string(&config::get().settings_file).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        for (k, v) in f {
            s[k] = v;
        }
    }
    s
}
pub fn open_signup() -> bool {
    settings()["openSignup"].as_bool().unwrap_or(true)
}
pub fn orgs() -> Vec<String> {
    settings()["orgs"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}
/// 소속은 목록 안에서만 고른다. 마음대로 적게 두면 같은 곳이 여러 이름으로 갈린다.
fn check_org(org: &str) -> Result<String, HttpError> {
    let org = org.trim();
    if orgs().iter().any(|o| o == org) { Ok(org.into()) } else { Err(http(400, "소속을 목록에서 골라 주세요")) }
}
pub fn save_settings(open: bool) {
    let mut s = settings();
    s["openSignup"] = Value::Bool(open);
    let _ = fs::write(&config::get().settings_file, serde_json::to_string_pretty(&s).unwrap());
}

fn secret() -> String {
    static SECRET: LazyLock<String> = LazyLock::new(|| {
        let c = config::get();
        match fs::read_to_string(&c.secret_file) {
            Ok(s) => s.trim().to_string(),
            Err(_) => {
                let s = hex::encode(random_bytes(32));
                let _ = fs::create_dir_all(&c.data_dir);
                fs::write(&c.secret_file, &s).expect("서명 키를 쓰지 못함");
                s
            }
        }
    });
    SECRET.clone()
}

/// 계정 해시. 서명 키로 만든 HMAC 앞 6자라 아이디를 알아도 키 없이는 해시를 셈할 수 없다 — 해시에서 사람을 거꾸로 찾지 못하게.
/// 서명 키(data/secret)를 지우면 모든 해시가 바뀐다. 지난 이력에 남은 해시는 그대로라 이어지지 않는다.
pub fn tag(id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret().as_bytes()).unwrap();
    mac.update(format!("tag:{id}").as_bytes());
    hex::encode(mac.finalize().into_bytes())[..6].to_string()
}

fn hash_password(pw: &str, salt: &str) -> String {
    // Node crypto.scryptSync 의 기본값. salt 는 16진 문자열 그 자체(바이트로 풀지 않음)를 쓴다.
    let params = scrypt::Params::new(14, 8, 1, 64).unwrap();
    let mut out = [0u8; 64];
    scrypt::scrypt(pw.as_bytes(), salt.as_bytes(), &params, &mut out).unwrap();
    hex::encode(out)
}

pub fn list_users() -> Vec<User> {
    let g = guard();
    load(&g).map(|db| db.users.iter().map(pub_user).collect()).unwrap_or_default()
}

/// 계정 수. 파일이 깨졌으면 1 로 본다 — 0 으로 보면 「첫 관리자 만들기」가 열린다.
pub fn user_count() -> usize {
    let g = guard();
    load(&g).map(|db| db.users.len()).unwrap_or(1)
}

/// 계정 해시 → 소속. 커밋 작성자는 해시뿐이라, 문서를 어느 본부 사람이 썼는지는 이 표로 되짚는다.
pub fn org_by_tag() -> HashMap<String, String> {
    let g = guard();
    load(&g).map(|db| db.users.iter().filter(|u| !u.org.is_empty()).map(|u| (tag(&u.id), u.org.clone())).collect()).unwrap_or_default()
}

pub fn find_user(id: &str) -> Option<User> {
    let g = guard();
    load(&g).ok()?.users.iter().find(|u| u.id == id).map(pub_user)
}

pub fn add_user(id: &str, org: &str, password: &str, role: &str) -> Result<User, HttpError> {
    let id = id.trim().to_lowercase();
    if !ID_RE.is_match(&id) {
        return Err(http(400, "아이디는 영문 소문자 · 숫자 · . _ - 로 2~32자입니다"));
    }
    let org = check_org(org)?;
    if password.chars().count() < 8 {
        return Err(http(400, "비밀번호는 8자 이상입니다"));
    }
    // scrypt 는 수십 ms 걸린다. 잠금 밖에서 계산해 다른 요청을 붙들지 않는다.
    let salt = hex::encode(random_bytes(16));
    let hash = hash_password(password, &salt);
    let g = guard();
    let mut db = load(&g)?;
    if db.users.iter().any(|u| u.id == id) {
        return Err(http(409, "이미 있는 아이디입니다"));
    }
    // 첫 계정은 관리자다. 관리자가 없으면 가입 설정을 바꿀 사람이 없다.
    let role = if db.users.is_empty() || role == "admin" { "admin" } else { "editor" };
    let mut rest = Map::new();
    rest.insert("created".into(), Value::String(now_iso()));
    db.users.push(Account { id: id.clone(), org, role: role.into(), hash, salt, tokens: vec![], rest });
    save(&g, &db)?;
    Ok(pub_user(db.users.last().unwrap()))
}

pub fn set_password(id: &str, password: &str) -> Result<(), HttpError> {
    if password.chars().count() < 8 {
        return Err(http(400, "비밀번호는 8자 이상입니다"));
    }
    let salt = hex::encode(random_bytes(16));
    let hash = hash_password(password, &salt);
    let g = guard();
    let mut db = load(&g)?;
    let u = db.users.iter_mut().find(|u| u.id == id).ok_or_else(|| http(404, "없는 계정입니다"))?;
    u.salt = salt;
    u.hash = hash;
    save(&g, &db)
}

pub fn set_org(id: &str, org: &str) -> Result<User, HttpError> {
    let org = check_org(org)?;
    let g = guard();
    let mut db = load(&g)?;
    let u = db.users.iter_mut().find(|u| u.id == id).ok_or_else(|| http(404, "없는 계정입니다"))?;
    u.org = org;
    let out = pub_user(u);
    save(&g, &db)?;
    Ok(out)
}

pub fn set_role(id: &str, role: &str) -> Result<(), HttpError> {
    let g = guard();
    let mut db = load(&g)?;
    let u = db.users.iter_mut().find(|u| u.id == id).ok_or_else(|| http(404, "없는 계정입니다"))?;
    u.role = if role == "admin" { "admin" } else { "editor" }.into();
    save(&g, &db)
}

pub fn verify(id: &str, password: &str) -> Option<User> {
    let id = id.trim().to_lowercase();
    let (user, salt, want) = {
        let g = guard();
        let db = load(&g).ok()?;
        let u = db.users.iter().find(|u| u.id == id)?;
        (pub_user(u), u.salt.clone(), u.hash.clone())
    };
    let got = hash_password(password, &salt);
    bool::from(got.as_bytes().ct_eq(want.as_bytes())).then_some(user)
}

// ── 세션 : 서명한 쿠키. 서버를 다시 켜도 로그인이 풀리지 않는다.
const DAY_MS: i64 = 24 * 3600 * 1000;

fn sign(body: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret().as_bytes()).unwrap();
    mac.update(body.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// (쿠키 값, 유효 기간 초)
pub fn session_cookie(user: &User, days: i64) -> (String, i64) {
    let exp = chrono::Utc::now().timestamp_millis() + days * DAY_MS;
    let body = format!("{}.{exp}", user.id);
    (format!("{body}.{}", sign(&body)), days * 24 * 3600)
}

pub fn user_from_cookie(v: &str) -> Option<User> {
    let i = v.rfind('.')?;
    let (body, sig) = (&v[..i], &v[i + 1..]);
    if !bool::from(sign(body).as_bytes().ct_eq(sig.as_bytes())) {
        return None;
    }
    let j = body.rfind('.')?;
    let exp: i64 = body[j + 1..].parse().ok()?;
    if exp <= chrono::Utc::now().timestamp_millis() {
        return None;
    }
    find_user(&body[..j])
}

// ── MCP 토큰 : 값은 만들 때 한 번만 보여 주고, 파일에는 해시만 남긴다.
fn sha(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

pub fn create_token(id: &str, label: &str) -> Result<Value, HttpError> {
    let g = guard();
    let mut db = load(&g)?;
    let u = db.users.iter_mut().find(|u| u.id == id).ok_or_else(|| http(404, "없는 계정입니다"))?;
    let raw = format!("wk_{}", URL_SAFE_NO_PAD.encode(random_bytes(24)));
    let label: String = if label.is_empty() { "MCP".into() } else { label.chars().take(60).collect() };
    let tok = Token { id: hex::encode(random_bytes(6)), label, hash: sha(&raw), created: now_iso(), used: None };
    let out = serde_json::json!({ "id": tok.id, "label": tok.label, "created": tok.created, "token": raw });
    u.tokens.push(tok);
    save(&g, &db)?;
    Ok(out)
}

pub fn list_tokens(id: &str) -> Vec<Value> {
    let g = guard();
    let Ok(db) = load(&g) else { return vec![] };
    db.users
        .iter()
        .find(|u| u.id == id)
        .map(|u| u.tokens.iter().map(|t| serde_json::json!({ "id": t.id, "label": t.label, "created": t.created, "used": t.used })).collect())
        .unwrap_or_default()
}

pub fn delete_token(id: &str, token_id: &str) -> Result<(), HttpError> {
    let g = guard();
    let mut db = load(&g)?;
    if let Some(u) = db.users.iter_mut().find(|u| u.id == id) {
        u.tokens.retain(|t| t.id != token_id);
        save(&g, &db)?;
    }
    Ok(())
}

/// 이 토큰이 있는지만 본다(기록하지 않음). 본문을 받기 전에 모르는 요청을 거르는 데 쓴다.
pub fn token_known(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }
    let h = sha(raw);
    let g = guard();
    load(&g).is_ok_and(|db| db.users.iter().any(|u| u.tokens.iter().any(|t| t.hash == h)))
}

pub fn user_from_token(raw: &str) -> Option<User> {
    if raw.is_empty() {
        return None;
    }
    let h = sha(raw);
    let g = guard();
    let mut db = load(&g).ok()?;
    let u = db.users.iter_mut().find(|u| u.tokens.iter().any(|t| t.hash == h))?;
    let user = pub_user(u);
    let t = u.tokens.iter_mut().find(|t| t.hash == h)?;
    // 마지막 사용 시각은 1분에 한 번만 적는다. 요청마다 계정 파일을 다시 쓰면 그만큼 경합 · 디스크 쓰기가 는다.
    let stale = t.used.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).is_none_or(|d| chrono::Utc::now().signed_duration_since(d).num_seconds() >= 60);
    if stale {
        t.used = Some(now_iso());
        let _ = save(&g, &db); // 기록은 덤이다. 못 써도 요청은 받는다
    }
    Some(user)
}

#[cfg(test)]
mod tests {
    #[test]
    fn node_scrypt_와_같은_해시() {
        // node -e "console.log(require('crypto').scryptSync('password123','abcd',64).toString('hex'))"
        // 이 값이 어긋나면 Node 판에서 만든 계정이 로그인하지 못한다.
        let want = "369653f98a00a3b2619d126e84ec4cdaa24dbc5fe2f4b850d53c1f5b3d943cb87574bb4d579822421da3a27159bf801bc44bd6958268da3f5af6403a889fe9d8";
        assert_eq!(super::hash_password("password123", "abcd"), want);
    }
}
