// Seesun Wiki 서버.
//
//   seesun-wiki                         서버를 켠다 (설정은 환경변수 · README 「설정」)
//   seesun-wiki user list               계정 목록
//   seesun-wiki user add <아이디> <소속> [admin]   비밀번호를 물어본다
//   seesun-wiki user passwd <아이디>     비밀번호를 물어본다
//   seesun-wiki user admin <아이디>      관리자로 올린다
//   seesun-wiki token <아이디> [이름표]   MCP 토큰을 만들어 찍는다 (scripts/wiki.mjs login 이 부른다)
//
// user · token 은 화면에 들어갈 수 없을 때 서버 PC 에서 쓰는 비상 창구다. data/users.json 을 바로 고친다.
mod api;
mod auth;
mod bundles;
mod config;
mod embed;
mod error;
mod frontmatter;
mod lint;
mod mcp;
mod pages;
mod search;
mod store;

use pages::Wiki;
use std::collections::HashMap;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

pub struct App {
    wiki: RwLock<Arc<Wiki>>,
    /// 로그인 실패 횟수 (주소 → 횟수, 마지막 실패). 10번 넘으면 10분 막는다
    attempts: Mutex<HashMap<String, (u32, Instant)>>,
    /// 다시 읽기를 한 줄로 세운다. 겹치면 먼저 시작해 옛 파일을 읽은 쪽이 나중에 끝나 새 목록을 덮을 수 있다.
    /// 차례로 돌면 마지막 다시 읽기가 늘 마지막 저장 뒤의 파일을 본다(2026.11.09 리뷰).
    reloading: tokio::sync::Mutex<()>,
}

impl App {
    /// 지금 문서 목록. 들고 있는 동안 저장이 일어나도 그 요청은 옛 목록을 끝까지 본다.
    pub fn wiki(&self) -> Arc<Wiki> {
        self.wiki.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    /// 저장한 뒤 부른다. 문서 목록 · 낱말 색인 · 단락 색인을 새로 만들고, 뜻 색인은 뒤에서 바뀐 단락만 다시 만든다.
    pub async fn reload(&self) -> anyhow::Result<()> {
        let _g = self.reloading.lock().await;
        let w = Arc::new(Wiki::load().await?);
        *self.wiki.write().unwrap_or_else(|e| e.into_inner()) = w.clone();
        embed::sync(w);
        Ok(())
    }
}

fn ask(q: &str) -> String {
    print!("{q}");
    let _ = std::io::stdout().flush();
    let mut s = String::new();
    let _ = std::io::stdin().read_line(&mut s);
    s.trim_end_matches(['\r', '\n']).to_string()
}

fn cli(args: &[String]) -> Result<(), String> {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let e = |e: error::HttpError| e.message;
    match a.as_slice() {
        ["user", "list"] => {
            for u in auth::list_users() {
                println!("{}\t{}\t{}\t{}", u.id, u.tag, u.org, u.role);
            }
        }
        ["user", "add", id, org, rest @ ..] => {
            let role = if rest.first() == Some(&"admin") { "admin" } else { "editor" };
            let u = auth::add_user(id, org, &ask("비밀번호 (8자 이상): "), role).map_err(e)?;
            println!("만듦 : {} · 해시 {} ({})", u.id, u.tag, u.role);
        }
        ["user", "passwd", id] => {
            auth::set_password(id, &ask("새 비밀번호 (8자 이상): ")).map_err(e)?;
            println!("바꿈");
        }
        ["user", "admin", id] => {
            auth::set_role(id, "admin").map_err(e)?;
            println!("관리자로 올림");
        }
        ["token", id, rest @ ..] => {
            let label = rest.first().copied().unwrap_or("명령줄");
            let t = auth::create_token(id, label).map_err(e)?;
            println!("{}", t["token"].as_str().unwrap_or(""));
        }
        _ => return Err("쓰는 법 : seesun-wiki [user list | user add <아이디> <소속> [admin] | user passwd <아이디> | user admin <아이디> | token <아이디> [이름표]]".into()),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        if let Err(m) = cli(&args) {
            eprintln!("{m}");
            std::process::exit(1);
        }
        return Ok(());
    }

    let c = config::get();
    store::init().await?;
    let wiki = Arc::new(Wiki::load().await?);
    let count = wiki.len();
    let app = Arc::new(App { wiki: RwLock::new(wiki.clone()), attempts: Mutex::new(HashMap::new()), reloading: tokio::sync::Mutex::new(()) });
    embed::start();
    embed::sync(wiki);

    let listener = tokio::net::TcpListener::bind((c.host.as_str(), c.port)).await?;
    println!("위키 : http://{}:{}  (문서 {count}장 · 저장소 {})", c.host, c.port, c.content_dir.display());
    axum::serve(listener, api::router(app).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
