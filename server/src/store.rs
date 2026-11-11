// 문서 저장소 : data/content 는 그 자체로 git 저장소다.
// 저장 한 번이 커밋 하나다. 그래서 누가 언제 무엇을 바꿨는지는 git 이력이 곧 정본이다.
use crate::auth::User;
use crate::bundles::{self, Registry};
use crate::config;
use crate::error::{AppError, HttpError, Res, http};
use anyhow::anyhow;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tokio::sync::Mutex;

const PAGES: &str = "pages";
const ASSETS: &str = "assets";

// git 은 한 저장소에서 동시에 커밋하면 index.lock 으로 실패한다. 쓰기는 한 줄로 세운다.
static WRITE: Mutex<()> = Mutex::const_new(());

fn dir() -> &'static Path {
    &config::get().content_dir
}

struct Author<'a> {
    name: &'a str,
    email: String,
}

/// 커밋 작성자는 계정 해시다. 이름 · 아이디 · 이메일을 남기면 저장소를 열어 보는 것만으로 누가 고쳤는지 드러난다(auth.rs 머리말).
fn author(user: &User) -> Author<'_> {
    Author { name: &user.tag, email: format!("{}@wiki.local", user.tag) }
}

async fn git(args: &[&str], who: Option<&Author<'_>>) -> anyhow::Result<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["-c", "core.quotepath=false", "-c", "core.autocrlf=false"]).args(args).current_dir(dir()).kill_on_drop(true);
    if let Some(a) = who {
        cmd.env("GIT_AUTHOR_NAME", a.name).env("GIT_AUTHOR_EMAIL", &a.email).env("GIT_COMMITTER_NAME", a.name).env("GIT_COMMITTER_EMAIL", &a.email);
    }
    let out = cmd.output().await?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!("git {} : {err}", args.first().unwrap_or(&"")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// 이력 읽기 캐시 : git log 의 결과는 HEAD 커밋이 같으면 늘 같다. 그래서 HEAD 를 열쇠로 출력을 들고 있다가 HEAD 가 바뀌면 통째로 버린다.
// 2026.11.11 : Windows 에서 git 을 한 번 띄우는 데만 40ms 쯤 들어, 문서 열기 · 모든 개념 · 최근 바뀜이 요청마다 50~100ms 걸렸다.
// HEAD 는 git 을 띄우지 않고 .git 파일에서 바로 읽는다 — 이 서버 밖에서 커밋해도(명령줄 git) HEAD 가 바뀌므로 낡은 이력을 내지 않는다.
static LOG_CACHE: std::sync::Mutex<(String, Option<HashMap<String, String>>)> = std::sync::Mutex::new((String::new(), None));
const LOG_CACHE_MAX: usize = 1000; // 넘치면 비운다. 문서 수 × 부르는 꼴 몇 가지라 평소에는 닿지 않는다

/// .git 에서 HEAD 커밋을 읽는다. 못 읽으면(묶인 refs 를 고치는 중 등) None — 그때는 캐시를 쓰지 않는다.
fn head_fs() -> Option<String> {
    let git_dir = dir().join(".git");
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    let Some(r) = head.strip_prefix("ref: ") else { return Some(head.to_string()) };
    if let Ok(h) = std::fs::read_to_string(git_dir.join(r)) {
        return Some(h.trim().to_string());
    }
    // gc 뒤에는 가지 끝이 packed-refs 안에만 있다.
    let packed = std::fs::read_to_string(git_dir.join("packed-refs")).ok()?;
    packed.lines().find_map(|l| l.split_once(' ').filter(|(_, name)| *name == r).map(|(h, _)| h.to_string()))
}

/// 읽기 전용 git log 를 HEAD 기준으로 캐시해서 부른다. 쓰기 명령에는 쓰지 않는다.
async fn git_log(args: &[&str]) -> anyhow::Result<String> {
    let Some(head) = head_fs() else { return git(args, None).await };
    let key = args.join("\u{1f}");
    {
        let mut c = LOG_CACHE.lock().unwrap();
        if c.0 != head {
            *c = (head.clone(), Some(HashMap::new()));
        }
        if let Some(hit) = c.1.as_ref().and_then(|m| m.get(&key)) {
            return Ok(hit.clone());
        }
    }
    let out = git(args, None).await?;
    let mut c = LOG_CACHE.lock().unwrap();
    // 부르는 사이에 커밋이 끼었으면 이 출력이 어느 HEAD 의 것인지 모르므로 담지 않는다.
    if c.0 == head && head_fs().as_deref() == Some(head.as_str()) {
        let m = c.1.get_or_insert_with(HashMap::new);
        if m.len() >= LOG_CACHE_MAX {
            m.clear();
        }
        m.insert(key, out.clone());
    }
    Ok(out)
}

pub async fn init() -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dir().join(PAGES)).await?;
    tokio::fs::create_dir_all(dir().join(ASSETS)).await?;
    if !dir().join(".git").exists() {
        git(&["init", "-b", "main"], None).await?;
        tokio::fs::write(dir().join(".gitattributes"), "*.md text eol=lf\n").await?;
        git(&["add", "-A"], None).await?;
        let system = Author { name: "위키", email: "system@wiki.local".into() };
        git(&["commit", "--allow-empty", "-m", "위키 저장소를 만든다"], Some(&system)).await?;
    }
    // 묶음 목록이 없는 저장소(2026.11.10 전에 만든 위키) : 지금 문서의 묶음으로 목록을 만들어 커밋한다.
    if !dir().join(bundles::FILE).exists() {
        let mut names: Vec<String> = list_files().await?.iter().map(|p| crate::pages::bundle_of(p).to_string()).filter(|b| !b.is_empty()).collect();
        names.sort();
        names.dedup();
        tokio::fs::write(dir().join(bundles::FILE), bundles::seed(&names).to_text()).await?;
        git(&["add", "--", bundles::FILE], None).await?;
        let system = Author { name: "위키", email: "system@wiki.local".into() };
        git(&["commit", "-m", "묶음 목록을 만든다"], Some(&system)).await?;
    }
    Ok(())
}

/// 묶음 · 권 목록. 파일이 없으면 빈 목록.
pub async fn read_registry() -> Registry {
    match tokio::fs::read_to_string(dir().join(bundles::FILE)).await {
        Ok(t) => Registry::parse(&t),
        Err(_) => Registry::default(),
    }
}

/// 묶음 · 권 목록을 고치고 커밋한다. 문서 쓰기와 같은 줄에 세워, 읽고 고치는 사이에 다른 저장이 끼지 않게 한다.
pub async fn update_registry(user: &User, message: &str, f: impl FnOnce(&mut Registry) -> Result<(), HttpError>) -> Res<WriteResult> {
    let _g = WRITE.lock().await;
    let mut reg = read_registry().await;
    f(&mut reg)?;
    tokio::fs::write(dir().join(bundles::FILE), reg.to_text()).await?;
    git(&["add", "--", bundles::FILE], None).await?;
    if git(&["diff", "--cached", "--name-only"], None).await?.trim().is_empty() {
        return Ok(WriteResult { commit: None, unchanged: true });
    }
    git(&["commit", "-m", message], Some(&author(user))).await?;
    Ok(WriteResult { commit: Some(head().await?), unchanged: false })
}

static BAD_SEG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"|?*\x00-\x1f]"#).unwrap());
static MD_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.md$").unwrap());
static REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,40}$").unwrap());

/// 문서 경로는 「개념/계류」처럼 폴더/이름이다. 밖으로 빠져나가는 경로를 막는다.
pub fn safe_path(p: &str) -> Result<String, HttpError> {
    let s = p.replace('\\', "/");
    let s = s.trim_matches('/');
    let clean = MD_EXT.replace(s, "").to_string();
    if clean.is_empty() || clean.split('/').any(|seg| seg.is_empty() || seg == "." || seg == ".." || BAD_SEG.is_match(seg)) {
        return Err(http(400, "문서 경로가 올바르지 않습니다"));
    }
    Ok(clean)
}

fn file(p: &str) -> String {
    format!("{PAGES}/{p}.md")
}

pub async fn list_files() -> anyhow::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let mut rd = tokio::fs::read_dir(dir().join(PAGES).join(&rel)).await?;
        while let Some(e) = rd.next_entry().await? {
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if e.file_type().await?.is_dir() {
                stack.push(r);
            } else if let Some(stem) = r.strip_suffix(".md") {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

pub async fn read(p: &str) -> Option<String> {
    tokio::fs::read_to_string(dir().join(file(p))).await.ok()
}

pub async fn head() -> anyhow::Result<String> {
    Ok(git(&["rev-parse", "HEAD"], None).await?.trim().to_string())
}

/// 마지막으로 이 문서를 바꾼 커밋. 편집 화면이 이 값을 들고 있다가 저장 때 견준다.
/// 2026.11.09 : 파일이 없으면 None. Node 판은 지운 커밋을 돌려줘서, 지운 경로에 새 문서를 만들면 늘 충돌이 났다.
pub async fn last_commit(p: &str) -> anyhow::Result<Option<String>> {
    if !dir().join(file(p)).exists() {
        return Ok(None);
    }
    let out = git_log(&["log", "-1", "--format=%H", "--", &file(p)]).await?;
    let h = out.trim();
    Ok((!h.is_empty()).then(|| h.to_string()))
}

#[derive(Serialize)]
pub struct WriteResult {
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
}

/// 문서를 쓰고 커밋한다.
/// base : 편집을 시작할 때 본 그 문서의 마지막 커밋. None 이면 견주지 않는다(되돌리기).
///        그 사이 누가 먼저 고쳤으면 덮어쓰지 않고 충돌을 알린다.
pub async fn write(p: &str, text: &str, user: &User, message: &str, base: Option<Option<String>>) -> Res<WriteResult> {
    let _g = WRITE.lock().await;
    let current = last_commit(p).await?;
    if let Some(base) = base
        && base != current
    {
        return Err(HttpError { status: 409, message: "편집하는 사이에 다른 사람이 이 문서를 고쳤습니다".into(), current: Some(current) }.into());
    }
    let abs = dir().join(file(p));
    if let Some(parent) = abs.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&abs, text.replace("\r\n", "\n")).await?;
    git(&["add", "--", &file(p)], None).await?;
    let changed = git(&["diff", "--cached", "--name-only"], None).await?;
    if changed.trim().is_empty() {
        return Ok(WriteResult { commit: current, unchanged: true });
    }
    let msg = if message.is_empty() { format!("{p} 고침") } else { message.to_string() };
    git(&["commit", "-m", &msg], Some(&author(user))).await?;
    Ok(WriteResult { commit: Some(head().await?), unchanged: false })
}

pub async fn remove(p: &str, user: &User, message: &str) -> Res<WriteResult> {
    let _g = WRITE.lock().await;
    git(&["rm", "-q", "--", &file(p)], None).await?;
    git(&["commit", "-m", message], Some(&author(user))).await?;
    Ok(WriteResult { commit: Some(head().await?), unchanged: false })
}

/// 이미 같은 이름이 있으면 true(그림 이름이 내용의 해시라 같은 그림이다).
pub async fn save_asset(name: &str, buf: &[u8], user: &User) -> Res<bool> {
    let _g = WRITE.lock().await;
    let rel = format!("{ASSETS}/{name}");
    let abs = dir().join(&rel);
    if abs.exists() {
        return Ok(true);
    }
    tokio::fs::write(&abs, buf).await?;
    git(&["add", "--", &rel], None).await?;
    git(&["commit", "-m", &format!("그림 {name} 올림")], Some(&author(user))).await?;
    Ok(false)
}

/// 자산(그림 · 움직이는 도식) 이름과 크기. 이름 차례대로. (2026.11.11 지우기와 함께)
pub async fn list_assets() -> anyhow::Result<Vec<(String, u64)>> {
    let mut out = Vec::new();
    let mut rd = tokio::fs::read_dir(dir().join(ASSETS)).await?;
    while let Some(e) = rd.next_entry().await? {
        let m = e.metadata().await?;
        let name = e.file_name().to_string_lossy().into_owned();
        if m.is_file() && !name.starts_with('.') {
            out.push((name, m.len()));
        }
    }
    out.sort();
    Ok(out)
}

/// 자산 하나를 지운다(커밋 하나). 쓰는 문서가 있는지는 부르는 쪽이 먼저 본다 — 문서 목록은 Wiki 가 들고 있다.
/// 파일은 사라져도 커밋 이력에 남으므로 git 으로 되살릴 수 있다.
pub async fn remove_asset(name: &str, user: &User, message: &str) -> Res<WriteResult> {
    let _g = WRITE.lock().await;
    // 이름만 받는다. 「../」 · 하위 폴더로 assets 밖이나 다른 파일을 지우지 못하게.
    let ok = Path::new(name).file_name().and_then(|s| s.to_str()) == Some(name) && !name.starts_with('.');
    if !ok {
        return Err(http(400, "자산 이름이 올바르지 않습니다").into());
    }
    let rel = format!("{ASSETS}/{name}");
    if !dir().join(&rel).is_file() {
        return Err(http(404, "그런 자산이 없습니다").into());
    }
    git(&["rm", "-q", "--", &rel], None).await?;
    git(&["commit", "-m", message], Some(&author(user))).await?;
    Ok(WriteResult { commit: Some(head().await?), unchanged: false })
}

pub fn asset_path(name: &str) -> PathBuf {
    let base = Path::new(name).file_name().map(|s| s.to_os_string()).unwrap_or_default();
    dir().join(ASSETS).join(base)
}

#[derive(Serialize, Clone)]
pub struct Commit {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub files: Vec<String>,
    /// 파일마다 무엇이 일어났나 (최근 바뀜만). 옮긴 문서를 「지움 + 새로 씀」이 아니라 「옮김」으로 보이려고 둔다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<Change>,
    /// 더한 줄 · 뺀 줄 (문서 이력만). 화면이 판마다 얼마나 바뀌었는지를 점 크기로 그린다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct Change {
    /// A 새로 씀 · M 고침 · D 지움 · R 옮김
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

fn page_name(x: &str) -> Option<String> {
    x.strip_prefix("pages/").map(|x| x.strip_suffix(".md").unwrap_or(x).to_string())
}

const FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f";

fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\x1e')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|line| {
            let f: Vec<&str> = line.split('\x1f').collect();
            let get = |i: usize| f.get(i).copied().unwrap_or("").to_string();
            // 머리 뒤에 오는 줄은 부르는 쪽 옵션에 따라 셋 중 하나다.
            //   --name-only   : pages/a.md
            //   --name-status : M<TAB>pages/a.md · R100<TAB>pages/옛.md<TAB>pages/새.md
            //   --numstat     : 3<TAB>1<TAB>pages/a.md (그림처럼 줄로 셀 수 없으면 -)
            let mut c = Commit { hash: get(0), author: get(1), email: get(2), date: get(3), subject: get(4), files: vec![], changes: vec![], added: None, removed: None };
            for x in f.get(5).copied().unwrap_or("").lines().map(str::trim).filter(|x| !x.is_empty()) {
                let cols: Vec<&str> = x.split('\t').collect();
                let num = |s: &str| s == "-" || (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
                if cols.len() >= 3 && num(cols[0]) && num(cols[1]) {
                    *c.added.get_or_insert(0) += cols[0].parse::<u32>().unwrap_or(0);
                    *c.removed.get_or_insert(0) += cols[1].parse::<u32>().unwrap_or(0);
                } else if cols.len() >= 2 {
                    let status = cols[0].chars().next().unwrap_or('M').to_string();
                    let Some(path) = page_name(cols[cols.len() - 1]) else { continue };
                    let from = if cols.len() >= 3 { page_name(cols[1]) } else { None };
                    c.files.push(path.clone());
                    c.changes.push(Change { status, path, from });
                } else if let Some(path) = page_name(x) {
                    c.files.push(path);
                }
            }
            c
        })
        .collect()
}

pub async fn history(p: &str, limit: usize) -> anyhow::Result<Vec<Commit>> {
    let out = git_log(&["log", &format!("-n{limit}"), "--follow", "--numstat", FORMAT, "--", &file(p)]).await?;
    Ok(parse_log(&out))
}

pub async fn recent(limit: usize) -> anyhow::Result<Vec<Commit>> {
    let out = git_log(&["log", &format!("-n{limit}"), FORMAT, "--name-status", "-M", "--", PAGES]).await?;
    Ok(parse_log(&out))
}

/// 문서마다 쓰거나 고친 사람(계정 해시). 모든 개념 화면의 「본부」 거르기가 쓴다.
/// 옮긴 문서는 옛 경로의 이력도 지금 경로로 모은다 — 그러지 않으면 묶음을 옮긴 사람 하나만 남는다.
pub async fn contributors() -> anyhow::Result<HashMap<String, Vec<String>>> {
    let out = git_log(&["log", FORMAT, "--name-status", "-M", "--", PAGES]).await?;
    let mut now: HashMap<String, String> = HashMap::new(); // 옛 경로 → 지금 경로. 새 판부터 거슬러 읽으므로 옮김을 먼저 만난다
    let mut res: HashMap<String, Vec<String>> = HashMap::new();
    for c in parse_log(&out) {
        for ch in &c.changes {
            let cur = now.get(&ch.path).cloned().unwrap_or_else(|| ch.path.clone());
            if let Some(from) = &ch.from {
                now.insert(from.clone(), cur.clone());
            }
            let who = res.entry(cur).or_default();
            if !who.contains(&c.author) {
                who.push(c.author.clone());
            }
        }
    }
    Ok(res)
}

fn check_rev(r: &str) -> Result<(), AppError> {
    if REV.is_match(r) { Ok(()) } else { Err(http(400, "판 번호가 올바르지 않습니다").into()) }
}

pub async fn read_at(p: &str, rev: &str) -> Res<Option<String>> {
    check_rev(rev)?;
    Ok(git(&["show", &format!("{rev}:{}", file(p))], None).await.ok())
}

pub async fn diff(p: &str, a: Option<&str>, b: &str) -> Res<String> {
    if let Some(a) = a {
        check_rev(a)?;
    }
    check_rev(b)?;
    // a 가 없으면 그 문서가 처음 생긴 판이다.
    let f = file(p);
    let out = match a {
        Some(a) => git(&["diff", "--no-color", "-U3", a, b, "--", &f], None).await?,
        None => git(&["show", "--no-color", "-U3", "--format=", b, "--", &f], None).await?,
    };
    Ok(out)
}
