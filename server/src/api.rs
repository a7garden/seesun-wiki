// 화면이 부르는 JSON API · 그림 · 만들어 둔 화면(web/dist)을 한 포트에서 낸다.
//
// 목차
//   1. 요청 공통   : 쿠키 → 로그인 사용자 · 쓰기 표지(x-wiki) · 프록시 뒤 주소
//   2. 읽기        : site · page · links · preview · search · changes · concepts · history · revision · diff  (로그인 없이)
//                    목록 · 검색 · 그래프는 묶음(b)을 받아 그 묶음과 공유 묶음만 낸다. b 가 없으면 site 가 고른 묶음 · 검색은 위키 전체
//   3. 쓰기        : page · page/delete · page/revert · assets · assets/delete · bundle · volume · volume/order (묶음 · 권 목록)  (로그인)
//                    assets/list (자산 · 쓰는 문서) 는 읽기라 로그인 없이
//   4. 계정        : login · logout · signup · password · tokens · admin
//   5. 화면        : web/dist 정적 파일, 나머지 주소는 index.html (길 찾기는 앱이 한다)
use crate::App;
use crate::auth::{self, User};
use crate::config;
use crate::error::{AppError, HttpError, Res, http};
use crate::frontmatter::stringify;
use crate::bundles;
use crate::pages::{self, to_page};
use crate::{embed, mcp, search, store};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower_http::services::ServeDir;

type St = State<Arc<App>>;
type Q = Query<HashMap<String, String>>;

// ── 1. 요청 공통

const COOKIE: &str = "wiki_session";

struct Req {
    user: Option<User>,
    marked: bool, // 화면이 붙이는 x-wiki: 1. 다른 사이트의 폼이 몰래 쓰는 것을 막는다
    secure: bool,
    proto: String,
    host: String,
    ip: String,
}

fn req(headers: &HeaderMap, peer: SocketAddr) -> Req {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let cookie = h("cookie")
        .split(';')
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned());
    // 같은 PC 의 역방향 프록시(loopback)가 넘겨준 머리글만 믿는다.
    let proxied = peer.ip().is_loopback();
    let fwd_proto = h("x-forwarded-proto");
    let proto = if proxied && !fwd_proto.is_empty() { fwd_proto.split(',').next().unwrap().trim().to_string() } else { "http".into() };
    let fwd_for = h("x-forwarded-for");
    let ip = if proxied && !fwd_for.is_empty() { fwd_for.rsplit(',').next().unwrap().trim().to_string() } else { peer.ip().to_string() };
    let fwd_host = h("x-forwarded-host");
    Req {
        user: cookie.and_then(|c| auth::user_from_cookie(&c)),
        marked: h("x-wiki") == "1",
        secure: proto == "https",
        host: if proxied && !fwd_host.is_empty() { fwd_host } else { h("host") },
        proto,
        ip,
    }
}

/// 쓰기 요청 : 표지가 있고 로그인했어야 한다.
fn writer(r: &Req) -> Result<&User, AppError> {
    if !r.marked {
        return Err(http(403, "잘못된 요청입니다").into());
    }
    r.user.as_ref().ok_or_else(|| http(401, "로그인해야 고칠 수 있습니다").into())
}
fn csrf(r: &Req) -> Result<(), AppError> {
    if r.marked { Ok(()) } else { Err(http(403, "잘못된 요청입니다").into()) }
}
fn signed_in(r: &Req) -> Result<&User, AppError> {
    r.user.as_ref().ok_or_else(|| http(401, "로그인해 주세요").into())
}
fn admin(u: &User) -> Result<(), AppError> {
    if u.role == "admin" { Ok(()) } else { Err(http(403, "관리자만 할 수 있습니다").into()) }
}

/// JSON 본문. 비었거나 깨졌으면 빈 객체로 본다(Node 판 express.json 과 같게).
fn body_json(b: &Bytes) -> Value {
    serde_json::from_slice(b).unwrap_or_else(|_| json!({}))
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
/// 글자로 바꾼 값 (숫자로 온 아이디 등)
fn text_of(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(o) => o.to_string(),
    }
}

fn not_found() -> AppError {
    http(404, "없는 문서입니다").into()
}

// ── 2. 읽기

/// 화면이 보는 묶음 : 요청한 묶음이 있으면 그것, 없으면 공유 묶음이 아닌 첫 묶음, 그것도 없으면 첫 묶음.
fn pick_bundle(wiki: &pages::Wiki, asked: Option<&String>) -> String {
    if let Some(b) = asked.filter(|b| wiki.has_bundle(b)) {
        return b.clone();
    }
    let all = wiki.bundles();
    all.iter().find(|(b, _)| !wiki.is_shared(b)).or(all.first()).map(|(b, _)| b.clone()).unwrap_or_default()
}

/// 검색 범위 : b 가 「*」 이거나 없으면 위키 전체.
fn scope_of(q: &HashMap<String, String>) -> String {
    q.get("b").filter(|b| b.as_str() != "*").cloned().unwrap_or_default()
}

async fn site(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Query(q): Q) -> Json<Value> {
    let r = req(&headers, peer);
    let wiki = app.wiki();
    let c = config::get();
    let bundle = pick_bundle(&wiki, q.get("b"));
    // 개념은 이 묶음과 공유 묶음을 함께 보인다. [[이름]] 이 이 묶음에 없으면 공유 묶음에서 찾으므로, 이 묶음에서 쓰는 용어 모음이 그 둘이다.
    let mut concepts: Vec<_> = wiki.all().filter(|p| p.kind == "concept" && wiki.in_scope(&p.path, &bundle)).map(|p| p.brief()).collect();
    concepts.sort_by_cached_key(|b| crate::pages::ko_key(&b.title));
    // 틀은 다른 문서에 끼워 넣을 조각(![[틀/주의]])이라 왼쪽 목록에 늘어놓지 않는다. 검색 · 그래프로는 찾는다.
    let others: Vec<_> = wiki.all().filter(|p| p.kind == "page" && p.bundle() == bundle && !pages::is_template(&p.path)).map(|p| p.brief()).collect();
    let mut manual = wiki.manual_tree(&bundle);
    for s in wiki.shared().iter().filter(|s| **s != bundle) {
        manual.extend(wiki.manual_tree(s));
    }
    let front = std::iter::once(format!("{bundle}/대문")).chain(wiki.shared().iter().map(|s| format!("{s}/대문"))).find(|p| wiki.get(p).is_some());
    let bundles: Vec<Value> = wiki
        .bundles()
        .into_iter()
        .map(|(name, count)| {
            let about = wiki.registry.bundle(&name).map(|b| b.about.clone()).unwrap_or_default();
            json!({ "name": name, "count": count, "shared": wiki.is_shared(&name), "about": about })
        })
        .collect();
    let base = if c.public_url.is_empty() { format!("{}://{}", r.proto, r.host) } else { c.public_url.trim_end_matches('/').to_string() };
    Json(json!({
        "name": c.site_name,
        "user": r.user,
        "openSignup": auth::open_signup(),
        "orgs": auth::orgs(),
        "needsSetup": auth::user_count() == 0,
        "bundle": bundle,
        "bundles": bundles,
        "shared": wiki.shared(),
        "front": front,
        "manual": manual,
        "concepts": concepts,
        "others": others,
        "mcpUrl": format!("{base}/mcp"),
        "search": { "semantic": embed::status() },
    }))
}

async fn page(State(app): St, Query(q): Q) -> Res<Json<Value>> {
    let p = store::safe_path(q.get("path").map(String::as_str).unwrap_or(""))?;
    let wiki = app.wiki();
    let pg = wiki.get(&p).ok_or_else(not_found)?;
    let last = store::history(&p, 1).await?.into_iter().next();
    let mut out = serde_json::to_value(pg.brief()).unwrap();
    out["meta"] = Value::Object(pg.meta.clone());
    out["body"] = json!(pg.body);
    out["commit"] = json!(last.as_ref().map(|c| &c.hash));
    out["updated"] = last.as_ref().map(|c| json!({ "author": c.author, "date": c.date })).unwrap_or(Value::Null);
    out["links"] = Value::Object(wiki.link_map(pg.links.iter().map(String::as_str), pg.bundle()));
    out["backlinks"] = json!(wiki.backlinks(&p));
    Ok(Json(out))
}

async fn links(State(app): St, body: Bytes) -> Json<Value> {
    let b = body_json(&body);
    let names: Vec<&str> = b.get("names").and_then(Value::as_array).map(|a| a.iter().take(500).filter_map(Value::as_str).collect()).unwrap_or_default();
    // from : 편집 중인 문서의 묶음. [[이름]] 을 그 묶음부터 찾는다.
    Json(Value::Object(app.wiki().link_map(names, s(&b, "from"))))
}

async fn preview(State(app): St, Query(q): Q) -> Res<Json<Value>> {
    let wiki = app.wiki();
    let from = q.get("from").map(String::as_str).unwrap_or("");
    let pg = wiki.resolve(q.get("name").map(String::as_str).unwrap_or(""), from).and_then(|p| wiki.get(p)).ok_or_else(not_found)?;
    Ok(Json(json!(pg.brief())))
}

async fn search_api(State(app): St, Query(q): Q) -> Res<Json<Value>> {
    let term = q.get("q").cloned().unwrap_or_default();
    let scope = scope_of(&q);
    let wiki = app.wiki();
    let hits = tokio::task::spawn_blocking(move || search::search(&wiki, &term, 30, &scope)).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!(hits)))
}

/// RAG 근거 찾기 : 찾을 말에 맞는 단락과 인용 주소. 답변 모델에 넘길 재료다(search.rs 「4. 근거 찾기」).
async fn retrieve(State(app): St, Query(q): Q) -> Res<Json<Value>> {
    let term = q.get("q").cloned().unwrap_or_default();
    let k = q.get("k").and_then(|v| v.parse::<usize>().ok()).unwrap_or(8).clamp(1, 30);
    let scope = scope_of(&q);
    let wiki = app.wiki();
    let hits = tokio::task::spawn_blocking(move || search::retrieve(&wiki, &term, k, &scope)).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!(hits)))
}

/// 문서 관계 그래프 : 문서가 점, [[링크]] 가 선. 「그래프」 화면이 그린다. 없는 문서로 가는 링크 · 자기 자신 링크는 뺀다.
/// b 를 주면 그 묶음과 공통 문서만 점으로 둔다.
async fn graph(State(app): St, Query(q): Q) -> Json<Value> {
    let wiki = app.wiki();
    let scope = scope_of(&q);
    let mut seen = std::collections::HashSet::new();
    let mut links = Vec::new();
    for pg in wiki.all().filter(|p| wiki.in_scope(&p.path, &scope)) {
        for name in &pg.links {
            let Some(to) = wiki.resolve(name, pg.bundle()) else { continue };
            if to == pg.path || !wiki.in_scope(to, &scope) || !seen.insert((pg.path.clone(), to.to_string())) {
                continue;
            }
            links.push(json!({ "source": pg.path, "target": to }));
        }
    }
    let nodes: Vec<Value> = wiki.all().filter(|p| wiki.in_scope(&p.path, &scope)).map(|pg| json!({ "id": pg.path, "title": pg.title, "kind": pg.kind, "bundle": pg.bundle() })).collect();
    Json(json!({ "nodes": nodes, "links": links }))
}

/// 최근 커밋. titles 는 바뀐 파일마다 지금 제목(지운 문서면 null) — 화면이 고른 묶음 밖 문서도 제목으로 보이게.
/// now 는 그 뒤에 옮겨진 문서의 지금 경로다. 2026.11.09 : 묶음으로 나누며 옮긴 문서의 옛 판이 「지움」으로 보였다.
async fn changes(State(app): St) -> Res<Json<Value>> {
    let list = store::recent(100).await?;
    let wiki = app.wiki();
    // 옛 경로 → 새 경로. 여러 번 옮겼으면 끝까지 따라간다(돌지 않게 횟수를 묶는다).
    let moved: HashMap<&str, &str> = list.iter().flat_map(|c| &c.changes).filter_map(|ch| ch.from.as_deref().map(|f| (f, ch.path.as_str()))).collect();
    let now = |f: &str| -> Option<String> {
        let mut p = f;
        for _ in 0..8 {
            if wiki.get(p).is_some() {
                return Some(p.to_string());
            }
            p = moved.get(p)?;
        }
        None
    };
    let out: Vec<Value> = list
        .iter()
        .map(|c| {
            let titles: serde_json::Map<String, Value> = c.files.iter().map(|f| (f.clone(), now(f).and_then(|p| wiki.get(&p).map(|pg| json!(pg.title))).unwrap_or(Value::Null))).collect();
            let current: serde_json::Map<String, Value> = c.files.iter().filter_map(|f| now(f).filter(|p| p != f).map(|p| (f.clone(), json!(p)))).collect();
            let mut v = json!(c);
            v["titles"] = Value::Object(titles);
            v["now"] = Value::Object(current);
            v
        })
        .collect();
    Ok(Json(json!(out)))
}

// 모든 개념 화면 : 묶음을 가리지 않고 모든 개념을, 쓰거나 고친 사람의 소속(본부)과 함께 낸다.
// 화면이 묶음 · 본부로 거르므로 site 의 concepts(이 묶음과 공통)로는 모자란다.
async fn concepts(State(app): St) -> Res<Json<Value>> {
    let who = store::contributors().await?;
    let org = auth::org_by_tag();
    let wiki = app.wiki();
    let mut list: Vec<Value> = wiki
        .all()
        .filter(|p| p.kind == "concept")
        .map(|p| {
            let mut orgs: Vec<&str> = who.get(&p.path).into_iter().flatten().filter_map(|t| org.get(t).map(String::as_str)).collect();
            orgs.sort();
            orgs.dedup();
            let mut v = json!(p.brief());
            v["orgs"] = json!(orgs);
            v
        })
        .collect();
    list.sort_by_cached_key(|v| pages::ko_key(v["title"].as_str().unwrap_or("")));
    Ok(Json(json!(list)))
}

async fn history(Query(q): Q) -> Res<Json<Value>> {
    let p = store::safe_path(q.get("path").map(String::as_str).unwrap_or(""))?;
    Ok(Json(json!(store::history(&p, 100).await?)))
}

async fn revision(State(app): St, Query(q): Q) -> Res<Json<Value>> {
    let p = store::safe_path(q.get("path").map(String::as_str).unwrap_or(""))?;
    let text = store::read_at(&p, q.get("rev").map(String::as_str).unwrap_or("")).await?.ok_or_else(|| http(404, "그 판에는 이 문서가 없습니다"))?;
    let pg = to_page(&p, &text);
    let links = app.wiki().link_map(pg.links.iter().map(String::as_str), pages::bundle_of(&p));
    Ok(Json(json!({ "path": p, "title": pg.title, "body": pg.body, "links": links })))
}

async fn diff(Query(q): Q) -> Res<Json<Value>> {
    let p = store::safe_path(q.get("path").map(String::as_str).unwrap_or(""))?;
    let a = q.get("a").map(String::as_str).filter(|s| !s.is_empty());
    Ok(Json(json!({ "diff": store::diff(&p, a, q.get("b").map(String::as_str).unwrap_or("")).await? })))
}

// ── 3. 쓰기

async fn save_page(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let p = store::safe_path(s(&b, "path"))?;
    let title = text_of(&b, "title").trim().to_string();
    if title.is_empty() {
        return Err(http(400, "제목을 넣어 주세요").into());
    }
    // base : 없음(키 없음) · null(새 문서) · 커밋. 이미 있는 문서를 base 없이 보내면 견주지 않는다(Node 판과 같게).
    let base: Option<Option<String>> = match b.get("base") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))),
    };
    let wiki = app.wiki();
    let exists = wiki.get(&p);
    if exists.is_none() && matches!(&base, Some(Some(c)) if !c.is_empty()) {
        return Err(http(404, "그 사이 문서가 지워졌습니다").into());
    }
    if exists.is_some() && base == Some(None) {
        return Err(HttpError { status: 409, message: "같은 경로의 문서가 이미 있습니다".into(), current: Some(store::last_commit(&p).await?) }.into());
    }
    if exists.is_none() {
        pages::check_new_path(&p).map_err(|m| http(400, &m))?;
    }
    let mut meta = exists.map(|pg| pg.meta.clone()).unwrap_or_default();
    meta.insert("title".into(), json!(title));
    let aliases: Vec<String> = b.get("aliases").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()).trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    if let Some(m) = wiki.name_clash(&p, &title, &aliases) {
        return Err(http(409, &m).into());
    }
    meta.insert("aliases".into(), json!(aliases));
    let order = match b.get("order") {
        Some(Value::Number(n)) => Some(Value::Number(n.clone())),
        Some(Value::String(t)) if !t.trim().is_empty() => t.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number),
        _ => None,
    };
    match order {
        Some(o) => {
            meta.insert("order".into(), o);
        }
        None => {
            meta.shift_remove("order");
        }
    }
    let message = match text_of(&b, "message").trim() {
        "" => format!("{title} {}", if exists.is_some() { "고침" } else { "새로 씀" }),
        m => m.to_string(),
    };
    let base = if exists.is_some() { base } else { Some(None) };
    drop(wiki);
    let w = store::write(&p, &stringify(&meta, &text_of(&b, "body")), user, &message, base).await?;
    app.reload().await?;
    let mut out = json!({ "path": p });
    merge(&mut out, json!(w));
    Ok(Json(out))
}

fn merge(a: &mut Value, b: Value) {
    if let (Value::Object(a), Value::Object(b)) = (a, b) {
        a.extend(b);
    }
}

async fn delete_page(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let p = store::safe_path(s(&b, "path"))?;
    let title = app.wiki().get(&p).map(|pg| pg.title.clone()).ok_or_else(not_found)?;
    let message = match text_of(&b, "message").trim() {
        "" => format!("{title} 지움"),
        m => m.to_string(),
    };
    let w = store::remove(&p, user, &message).await?;
    app.reload().await?;
    Ok(Json(json!(w)))
}

/// 지난 판으로 되돌리기는 그 판의 내용으로 새 커밋을 하나 더 만든다. 이력은 지우지 않는다.
async fn revert(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let p = store::safe_path(s(&b, "path"))?;
    let rev = text_of(&b, "rev");
    let text = store::read_at(&p, &rev).await?.ok_or_else(|| http(404, "그 판에는 이 문서가 없습니다"))?;
    let short: String = rev.chars().take(7).collect();
    let w = store::write(&p, &text, user, &format!("{short} 판으로 되돌림"), None).await?;
    app.reload().await?;
    let mut out = json!({ "path": p });
    merge(&mut out, json!(w));
    Ok(Json(out))
}

// 묶음 · 권 목록(bundles.json). 편집자 누구나 만들고 고친다(2026.11.10 사용자 결정).
// 이름 바꾸기는 없다 — 이름이 문서 경로의 한 칸이라, 바꾸면 그 안 문서를 모두 옮기고 [[묶음/이름]] 링크를 고쳐야 한다.
// 지우기는 문서가 하나도 없을 때만 된다. 문서가 있는 묶음을 목록에서 빼도 경로에서 다시 생겨 지운 것처럼 보이지 않는다.

/// 「묶음과 권」 화면 : 모든 묶음과 그 안 매뉴얼 권. site 는 지금 묶음과 공유 묶음의 권만 내므로 따로 둔다.
async fn list_bundles(State(app): St) -> Json<Value> {
    let wiki = app.wiki();
    let out: Vec<Value> = wiki
        .bundles()
        .into_iter()
        .map(|(name, count)| {
            let info = wiki.registry.bundle(&name);
            let volumes: Vec<Value> = wiki
                .manual_tree(&name)
                .into_iter()
                .filter(|v| v["name"].as_str().is_some_and(|n| !n.is_empty()))
                .map(|v| {
                    let n = v["name"].as_str().unwrap_or("");
                    let order = wiki.registry.volume(&name, n).and_then(|x| x.order);
                    json!({ "name": n, "about": v["about"], "order": order, "count": v["items"].as_array().map_or(0, Vec::len), "listed": wiki.registry.volume(&name, n).is_some() })
                })
                .collect();
            json!({ "name": name, "count": count, "shared": wiki.is_shared(&name), "about": info.map(|b| b.about.clone()).unwrap_or_default(), "listed": info.is_some(), "volumes": volumes })
        })
        .collect();
    Json(json!(out))
}

fn bool_of(v: &Value, k: &str) -> bool {
    matches!(v.get(k), Some(Value::Bool(true)))
}

async fn save_bundle(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let name = bundles::check_bundle_name(&text_of(&b, "name")).map_err(|m| http(400, &m))?;
    let (about, shared, create) = (text_of(&b, "about").trim().to_string(), bool_of(&b, "shared"), bool_of(&b, "create"));
    let exists = app.wiki().has_bundle(&name);
    if create && exists {
        return Err(http(409, &format!("「{name}」 묶음이 이미 있습니다")).into());
    }
    if !create && !exists {
        return Err(http(404, "없는 묶음입니다").into());
    }
    let message = if create { format!("{name} 묶음 만듦") } else { format!("{name} 묶음 설명 · 공유 고침") };
    let w = store::update_registry(user, &message, |reg| {
        match reg.bundles.iter_mut().find(|x| x.name == name) {
            Some(x) => {
                x.about = about;
                x.shared = shared;
            }
            None => reg.bundles.push(bundles::BundleInfo { name: name.clone(), about, shared, rest: Default::default() }),
        }
        Ok(())
    })
    .await?;
    app.reload().await?;
    Ok(Json(json!(w)))
}

async fn delete_bundle(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let name = text_of(&body_json(&body), "name").trim().to_string();
    let left = app.wiki().all().filter(|p| p.bundle() == name).count();
    if left > 0 {
        return Err(http(409, &format!("「{name}」 묶음에 문서 {left}개가 남아 있어 지울 수 없습니다. 문서를 먼저 지우거나 옮겨 주세요")).into());
    }
    let w = store::update_registry(user, &format!("{name} 묶음 지움"), |reg| {
        if reg.bundle(&name).is_none() {
            return Err(http(404, "없는 묶음입니다"));
        }
        reg.bundles.retain(|x| x.name != name);
        reg.volumes.retain(|v| v.bundle != name);
        Ok(())
    })
    .await?;
    app.reload().await?;
    Ok(Json(json!(w)))
}

fn volume_docs(wiki: &pages::Wiki, bundle: &str, name: &str) -> usize {
    wiki.all().filter(|p| p.kind == "manual" && p.bundle() == bundle && p.volume() == name).count()
}

async fn save_volume(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let bundle = text_of(&b, "bundle").trim().to_string();
    let name = bundles::check_name(&text_of(&b, "name"), "권").map_err(|m| http(400, &m))?;
    let (about, create) = (text_of(&b, "about").trim().to_string(), bool_of(&b, "create"));
    let order = match b.get("order") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(t)) if !t.trim().is_empty() => Some(t.trim().parse::<f64>().map_err(|_| http(400, "권 순서는 숫자로 넣어 주세요"))?),
        _ => None,
    };
    let exists = {
        let wiki = app.wiki();
        if !wiki.has_bundle(&bundle) {
            return Err(http(404, "없는 묶음입니다").into());
        }
        wiki.registry.volume(&bundle, &name).is_some() || volume_docs(&wiki, &bundle, &name) > 0
    };
    if create && exists {
        return Err(http(409, &format!("「{bundle}」 묶음에 「{name}」 권이 이미 있습니다")).into());
    }
    if !create && !exists {
        return Err(http(404, "없는 권입니다").into());
    }
    let message = if create { format!("{bundle} 묶음에 {name} 권 만듦") } else { format!("{bundle} 묶음 {name} 권 고침") };
    let w = store::update_registry(user, &message, |reg| {
        match reg.volumes.iter_mut().find(|v| v.bundle == bundle && v.name == name) {
            Some(v) => {
                v.about = about;
                v.order = order;
            }
            None => reg.volumes.push(bundles::VolumeInfo { bundle: bundle.clone(), name: name.clone(), about, order, rest: Default::default() }),
        }
        // 묶음 목록에 없던 묶음(문서 경로로만 있던 것)에 권을 만들면 묶음도 목록에 올린다.
        if reg.bundle(&bundle).is_none() {
            reg.bundles.push(bundles::BundleInfo { name: bundle.clone(), ..Default::default() });
        }
        Ok(())
    })
    .await?;
    app.reload().await?;
    Ok(Json(json!(w)))
}

async fn delete_volume(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let (bundle, name) = (text_of(&b, "bundle").trim().to_string(), text_of(&b, "name").trim().to_string());
    let left = volume_docs(&app.wiki(), &bundle, &name);
    if left > 0 {
        return Err(http(409, &format!("「{name}」 권에 문서 {left}개가 남아 있어 지울 수 없습니다")).into());
    }
    let w = store::update_registry(user, &format!("{bundle} 묶음 {name} 권 지움"), |reg| {
        if reg.volume(&bundle, &name).is_none() {
            return Err(http(404, "없는 권입니다"));
        }
        reg.volumes.retain(|v| !(v.bundle == bundle && v.name == name));
        Ok(())
    })
    .await?;
    app.reload().await?;
    Ok(Json(json!(w)))
}

// 권 순서 한꺼번에 : 「묶음과 권」에서 권을 위아래로 옮기면 그 묶음의 권 차례 전체를 받아 10 · 20 · 30 … 으로 다시 매긴다.
// 2026.11.10 : 순서를 숫자 칸으로 넣던 것을 옮기기 단추로 바꿨다. 권마다 /volume 을 부르면 한 번 옮길 때 커밋이 둘 이상 남는다.
async fn order_volumes(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    let bundle = text_of(&b, "bundle").trim().to_string();
    let names: Vec<String> = b.get("names").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    {
        let wiki = app.wiki();
        if !wiki.has_bundle(&bundle) {
            return Err(http(404, "없는 묶음입니다").into());
        }
        // 없는 권 이름이 섞이면 목록에 빈 권이 생긴다
        if let Some(n) = names.iter().find(|n| wiki.registry.volume(&bundle, n).is_none() && volume_docs(&wiki, &bundle, n) == 0) {
            return Err(http(404, &format!("「{n}」 권이 없습니다")).into());
        }
    }
    if names.is_empty() {
        return Err(http(400, "권 차례가 비었습니다").into());
    }
    let w = store::update_registry(user, &format!("{bundle} 묶음 권 순서 고침"), |reg| {
        for (i, name) in names.iter().enumerate() {
            let order = Some(((i + 1) * 10) as f64);
            match reg.volumes.iter_mut().find(|v| v.bundle == bundle && v.name == *name) {
                Some(v) => v.order = order,
                None => reg.volumes.push(bundles::VolumeInfo { bundle: bundle.clone(), name: name.clone(), order, ..Default::default() }),
            }
        }
        if reg.bundle(&bundle).is_none() {
            reg.bundles.push(bundles::BundleInfo { name: bundle.clone(), ..Default::default() });
        }
        Ok(())
    })
    .await?;
    app.reload().await?;
    Ok(Json(json!(w)))
}

// 2026.11.11 : html 을 더했다. 캔버스 애니메이션 · 단계별 시뮬레이션처럼 그림 한 장으로 담을 수 없는 도식을 문서에 끼운다.
//   본문에서 ![설명](/assets/….html) 로 쓰면 화면이 격리된 틀(iframe sandbox)로 그린다. 내보낼 때도 격리한다(아래 asset).
const IMG: [(&str, &str); 5] =[("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp"), ("text/html", "html")];

async fn upload(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    // 「text/html; charset=utf-8」 처럼 뒤에 붙은 값은 떼고 본다
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim();
    let ext = IMG.iter().find(|(t, _)| *t == ct).map(|(_, e)| *e);
    let Some(ext) = ext.filter(|_| !body.is_empty()) else {
        return Err(http(400, "png · jpg · gif · webp 그림이나 html 도식만 올릴 수 있습니다").into());
    };
    let name = format!("{}.{ext}", &hex::encode(Sha256::digest(&body))[..16]);
    store::save_asset(&name, &body, user).await?;
    Ok(Json(json!({ "url": format!("/assets/{name}") })))
}

async fn asset(Path(name): Path<String>) -> Response {
    let f = store::asset_path(&name);
    let Ok(buf) = tokio::fs::read(&f).await else { return StatusCode::NOT_FOUND.into_response() };
    let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "html" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    };
    // 파일 이름이 내용의 해시라 한 번 받은 그림은 다시 받을 일이 없다.
    let cache = (header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    if ext == "html" {
        // 누구나 올리는 스크립트라 위키와 같은 출처로 돌리지 않는다.
        //   sandbox allow-scripts : 출처가 없는 문서로 연다. 주소창에서 바로 열어도 위키의 쿠키 · 저장소 · API 에 닿지 못한다
        //   connect-src 'none'    : 밖으로 요청을 보내지 못한다 (자료를 빼 가거나 다른 곳을 부르지 못하게)
        //   frame-ancestors 'self': 위키 문서 안에서만 끼울 수 있다
        // 그래서 끼우는 html 은 글꼴 · 라이브러리까지 한 파일에 담아야 한다 (그림 표준 「움직이는 도식」).
        const CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; \
                           img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-ancestors 'self'";
        return (
            [(header::CONTENT_TYPE, mime), (header::CONTENT_SECURITY_POLICY, CSP), (header::X_CONTENT_TYPE_OPTIONS, "nosniff"), (header::REFERRER_POLICY, "no-referrer"), cache],
            with_scrollbar(buf),
        )
            .into_response();
    }
    ([(header::CONTENT_TYPE, mime), cache], buf).into_response()
}

// 2026.11.11 : 틀 안 문서의 스크롤바를 위키 본문처럼 얇고 옅게 그린다.
//   틀 안은 출처가 없는 별개 문서라 위키 CSS 가 닿지 않는다 — 넣지 않으면 브라우저 기본의 굵은 회색 막대가 둥근 틀 안에 그대로 선다.
//   <head> 맨 앞에 두고 :where() 로 우선순위를 0 으로 낮춰, 문서가 스스로 스크롤바를 꾸몄으면 그쪽이 이긴다.
//   <head> 가 없으면 <html> 뒤 · <!doctype> 뒤 순서로 찾는다. doctype 앞에 넣으면 옛 방식(quirks) 화면이 된다.
//   색 : 위키는 밝은 · 어두운 화면을 <html class="dark"> 로 바꾸므로 틀 안의 prefers-color-scheme 만으로는 맞지 않는다.
//        위키 화면이 { type: 'wiki-theme', theme } 를 보내면 <html data-wiki-theme> 에 적고 그 색을 쓴다. 받기 전에는 시스템 설정을 따른다.
//        막대 색은 위키 본문 스크롤바(글자색 22%)와 같다. 도식도 data-wiki-theme 을 보고 제 색을 바꿀 수 있다.
const SCROLLBAR: &str = "<style>\
:where(html){scrollbar-color:rgba(0,0,0,.22) transparent}\
@media (prefers-color-scheme:dark){:where(html){scrollbar-color:rgba(255,255,255,.24) transparent}}\
:where(html[data-wiki-theme=light]){scrollbar-color:rgba(0,0,0,.22) transparent}\
:where(html[data-wiki-theme=dark]){scrollbar-color:rgba(255,255,255,.24) transparent}\
:where(*){scrollbar-width:thin}</style>\
<script>addEventListener('message',function(e){var d=e.data;if(e.source===parent&&d&&d.type==='wiki-theme')document.documentElement.setAttribute('data-wiki-theme',d.theme==='dark'?'dark':'light')})</script>";
fn with_scrollbar(buf: Vec<u8>) -> Vec<u8> {
    let low = buf.to_ascii_lowercase();
    let after = |tag: &[u8]| -> Option<usize> {
        // 이름 뒤가 > · 빈칸이어야 그 태그다 (<head 가 <header 에 걸리지 않게)
        let at = (0..low.len().saturating_sub(tag.len())).find(|&i| low[i..].starts_with(tag) && matches!(low[i + tag.len()], b'>' | b' ' | b'\t' | b'\r' | b'\n'))?;
        let end = low[at..].iter().position(|&c| c == b'>')?;
        Some(at + end + 1)
    };
    let at = after(b"<head").or_else(|| after(b"<html")).or_else(|| after(b"<!doctype")).unwrap_or(0);
    [&buf[..at], SCROLLBAR.as_bytes(), &buf[at..]].concat()
}

/// 자산 목록 : 이름 · 크기 · 쓰는 문서. 쓰는 문서가 없는 것이 지울 후보다 (2026.11.11).
pub async fn assets_report(app: &App) -> anyhow::Result<Vec<Value>> {
    let wiki = app.wiki();
    Ok(store::list_assets()
        .await?
        .into_iter()
        .map(|(name, size)| json!({ "name": name, "url": format!("/assets/{name}"), "size": size, "used_by": wiki.asset_users(&name) }))
        .collect())
}

async fn list_assets(State(app): St) -> Res<Json<Value>> {
    Ok(Json(json!(assets_report(&app).await?)))
}

/// 자산 하나를 지운다. 본문에 쓰는 문서가 있으면 거절한다 — 지우면 그 문서에 깨진 그림이 남는다.
pub async fn remove_asset(app: &App, user: &User, name: &str) -> Res<store::WriteResult> {
    let users = app.wiki().asset_users(name);
    if !users.is_empty() {
        return Err(http(409, format!("이 자산을 쓰는 문서가 있어 지우지 않습니다 : {}", users.join(" · "))).into());
    }
    store::remove_asset(name, user, &format!("자산 {name} 지움")).await
}

async fn delete_asset(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    let b = body_json(&body);
    Ok(Json(json!(remove_asset(&app, user, s(&b, "name")).await?)))
}

// ── 4. 계정

fn session(r: &Req, user: &User) -> HeaderValue {
    let (v, max_age) = auth::session_cookie(user, 30);
    let expires = (chrono::Utc::now() + chrono::Duration::seconds(max_age)).format("%a, %d %b %Y %H:%M:%S GMT");
    let secure = if r.secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}={v}; Max-Age={max_age}; Path=/; Expires={expires}; HttpOnly{secure}; SameSite=Lax")).unwrap()
}

fn with_cookie(cookie: Option<HeaderValue>, body: Value) -> Response {
    let mut res = Json(body).into_response();
    if let Some(c) = cookie {
        res.headers_mut().insert(header::SET_COOKIE, c);
    }
    res
}

async fn login(State(app): St, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Response> {
    let r = req(&headers, peer);
    csrf(&r)?;
    let b = body_json(&body);
    // 확인과 셈을 한 잠금 안에서 한다 : 먼저 실패 한 번으로 셈해 두고, 맞으면 지운다.
    // 확인 → 비밀번호 검사(수십 ms) → 기록 순이면 그사이 들어온 요청이 모두 확인을 지나, 한꺼번에 60번을 보내도 막히지 않았다(2026.11.09 리뷰).
    {
        let mut tries = app.attempts.lock().unwrap_or_else(|e| e.into_inner());
        let (n, t) = tries.get(&r.ip).copied().unwrap_or((0, Instant::now()));
        let fresh = t.elapsed() < Duration::from_secs(600);
        if n >= 10 && fresh {
            return Err(http(429, "로그인을 너무 많이 실패했습니다. 10분 뒤에 다시 해 주세요").into());
        }
        tries.insert(r.ip.clone(), (if fresh { n + 1 } else { 1 }, Instant::now()));
    }
    let (id, pw) = (text_of(&b, "id"), text_of(&b, "password"));
    let user = tokio::task::spawn_blocking(move || auth::verify(&id, &pw)).await.map_err(|e| AppError::Internal(e.into()))?;
    let Some(user) = user else {
        return Err(http(401, "아이디나 비밀번호가 맞지 않습니다").into());
    };
    app.attempts.lock().unwrap_or_else(|e| e.into_inner()).remove(&r.ip);
    Ok(with_cookie(Some(session(&r, &user)), json!(user)))
}

async fn logout(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Res<Response> {
    csrf(&req(&headers, peer))?;
    Ok(with_cookie(Some(HeaderValue::from_static("wiki_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")), json!({})))
}

async fn signup(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Response> {
    let r = req(&headers, peer);
    csrf(&r)?;
    let first = auth::user_count() == 0;
    let by_admin = r.user.as_ref().is_some_and(|u| u.role == "admin");
    if !first && !auth::open_signup() && !by_admin {
        return Err(http(403, "지금은 관리자만 계정을 만들 수 있습니다").into());
    }
    let b = body_json(&body);
    // 2026.11.09 : 권한은 관리자가 만들 때만 받는다. Node 판은 본문의 role 을 그대로 받아 누구나 관리자로 가입할 수 있었다.
    let role = if by_admin { text_of(&b, "role") } else { String::new() };
    let (id, org, pw) = (text_of(&b, "id"), text_of(&b, "org"), text_of(&b, "password"));
    let user = tokio::task::spawn_blocking(move || auth::add_user(&id, &org, &pw, &role)).await.map_err(|e| AppError::Internal(e.into()))??;
    let cookie = r.user.is_none().then(|| session(&r, &user));
    Ok(with_cookie(cookie, json!(user)))
}

async fn password(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?.clone();
    let b = body_json(&body);
    let (cur, next) = (text_of(&b, "current"), text_of(&b, "password"));
    tokio::task::spawn_blocking(move || {
        if auth::verify(&user.id, &cur).is_none() {
            return Err(http(400, "지금 비밀번호가 맞지 않습니다"));
        }
        auth::set_password(&user.id, &next)
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))??;
    Ok(Json(json!({})))
}

async fn profile(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    Ok(Json(json!(auth::set_org(&user.id, &text_of(&body_json(&body), "org"))?)))
}

async fn tokens(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    Ok(Json(json!(auth::list_tokens(&signed_in(&r)?.id))))
}

async fn create_token(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    Ok(Json(auth::create_token(&user.id, &text_of(&body_json(&body), "label"))?))
}

async fn delete_token(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let user = writer(&r)?;
    auth::delete_token(&user.id, &text_of(&body_json(&body), "id"))?;
    Ok(Json(json!({})))
}

async fn admin_get(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    admin(signed_in(&r)?)?;
    Ok(Json(json!({ "users": auth::list_users(), "settings": auth::settings() })))
}

async fn admin_settings(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    admin(writer(&r)?)?;
    let open = body_json(&body).get("openSignup").is_some_and(|v| matches!(v, Value::Bool(true)) || v.as_f64().is_some_and(|n| n != 0.0) || v.as_str().is_some_and(|s| !s.is_empty()));
    auth::save_settings(open);
    Ok(Json(auth::settings()))
}

async fn admin_role(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    let me = writer(&r)?;
    admin(me)?;
    let b = body_json(&body);
    let id = text_of(&b, "id");
    if id == me.id {
        return Err(http(400, "자기 권한은 바꿀 수 없습니다").into());
    }
    auth::set_role(&id, s(&b, "role"))?;
    Ok(Json(json!(auth::list_users())))
}

async fn admin_password(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Bytes) -> Res<Json<Value>> {
    let r = req(&headers, peer);
    admin(writer(&r)?)?;
    let b = body_json(&body);
    let (id, pw) = (text_of(&b, "id"), text_of(&b, "password"));
    tokio::task::spawn_blocking(move || auth::set_password(&id, &pw)).await.map_err(|e| AppError::Internal(e.into()))??;
    Ok(Json(json!({})))
}

async fn api_missing() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "없는 주소입니다" }))).into_response()
}

async fn mcp_post(State(app): St, headers: HeaderMap, body: Bytes) -> Response {
    mcp::handle(app, headers, body).await
}
async fn mcp_other() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, Json(json!({ "error": "POST 로 붙어 주세요" }))).into_response()
}

// ── 5. 화면

async fn index_html(method: Method) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }
    let index = config::get().root.join("web").join("dist").join("index.html");
    match tokio::fs::read(&index).await {
        Ok(b) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], b).into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "화면이 아직 만들어지지 않았습니다. npm run build 를 먼저 돌려 주세요.")
            .into_response(),
    }
}

pub fn router(app: Arc<App>) -> Router {
    const MB: usize = 1024 * 1024;
    let api = Router::new()
        .route("/site", get(site))
        .route("/page", get(page).post(save_page))
        .route("/links", post(links))
        .route("/preview", get(preview))
        .route("/search", get(search_api))
        .route("/retrieve", get(retrieve))
        .route("/graph", get(graph))
        .route("/changes", get(changes))
        .route("/concepts", get(concepts))
        .route("/history", get(history))
        .route("/revision", get(revision))
        .route("/diff", get(diff))
        .route("/page/delete", post(delete_page))
        .route("/page/revert", post(revert))
        .route("/bundles", get(list_bundles))
        .route("/bundle", post(save_bundle))
        .route("/bundle/delete", post(delete_bundle))
        .route("/volume", post(save_volume))
        .route("/volume/delete", post(delete_volume))
        .route("/volume/order", post(order_volumes))
        .route("/assets", post(upload).layer(DefaultBodyLimit::max(15 * MB)).layer(axum::middleware::from_fn(gate_writer)))
        .route("/assets/list", get(list_assets))
        .route("/assets/delete", post(delete_asset))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/signup", post(signup))
        .route("/password", post(password))
        .route("/profile", post(profile))
        .route("/tokens", get(tokens).post(create_token))
        .route("/tokens/delete", post(delete_token))
        .route("/admin", get(admin_get))
        .route("/admin/settings", post(admin_settings))
        .route("/admin/role", post(admin_role))
        .route("/admin/password", post(admin_password))
        .fallback(api_missing)
        .layer(DefaultBodyLimit::max(4 * MB));

    let dist = config::get().root.join("web").join("dist");
    let static_files = ServeDir::new(dist).append_index_html_on_directories(false).fallback(axum::routing::any(index_html));

    Router::new()
        .nest("/api", api)
        .route("/mcp", post(mcp_post).layer(DefaultBodyLimit::max(25 * MB)).layer(axum::middleware::from_fn(gate_token)).fallback(mcp_other))
        .route("/assets/{name}", get(asset))
        .fallback_service(static_files)
        .layer(axum::middleware::map_response(static_cache))
        // 2026.11.11 : 화면 JS · JSON 을 gzip 으로 낸다(631KB → 약 180KB). 그림 · 아주 작은 응답은 기본 조건이 알아서 뺀다.
        .layer(tower_http::compression::CompressionLayer::new())
        .with_state(app)
}

// 본문이 큰 두 주소는 본문을 받기 전에 머리글만 보고 거른다. 처리 함수가 본문을 인자로 받으면
// 로그인 확인보다 본문 읽기(그림 15MB · MCP 25MB)가 먼저 일어나, 모르는 요청도 그만큼 메모리를 먹었다(2026.11.09 리뷰).

async fn gate_writer(ConnectInfo(peer): ConnectInfo<SocketAddr>, request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    match writer(&req(request.headers(), peer)) {
        Ok(_) => next.run(request).await,
        Err(e) => e.into_response(),
    }
}

async fn gate_token(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let raw = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(mcp::bearer).unwrap_or_default();
    if auth::token_known(&raw) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "위키 계정 화면에서 MCP 토큰을 만들어 Authorization: Bearer <토큰> 으로 붙여 주세요" }))).into_response()
    }
}

/// 화면 파일(/static/…)은 1시간 붙들어 둔다. API 응답에는 붙이지 않는다.
async fn static_cache(uri: axum::http::Uri, mut res: Response) -> Response {
    if uri.path().starts_with("/static/") && res.status().is_success() && !res.headers().contains_key(header::CACHE_CONTROL) {
        res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"));
    }
    res
}
