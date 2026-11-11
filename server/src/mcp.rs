// MCP : 사람이 쓰는 AI 도구(Claude Code 등)가 위키를 찾아 읽고 고치게 하는 창구.
// 계정마다 발급한 토큰으로 붙는다. 토큰의 주인이 커밋의 작성자가 된다.
//
// Streamable HTTP 의 「세션 없음 · JSON 응답」 꼴만 쓴다. 위키는 상태를 git 에 두므로 MCP 세션이 기억할 것이 없다.
// 2026.11.09 : 그 꼴이면 JSON-RPC 몇 갈래(initialize · tools/list · tools/call · ping)뿐이라 SDK(rmcp) 없이 직접 받는다.
//
// 목차
//   1. 안내문(INSTRUCTIONS) · 도구 정의(tools)
//   2. 도구 처리(call) : 찾기 · 근거 단락 · 읽기 · 이력 · 쓰기 · 표준 · 그림
//   3. JSON-RPC 받기(handle) : 토큰 · 묶음 요청 · 알림
use crate::App;
use crate::auth::{self, User};
use crate::error::AppError;
use crate::frontmatter::stringify;
use crate::{lint, pages, search, store};
use axum::Json;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const INSTRUCTIONS: &str = "Seesun Wiki 는 사내 위키다. 문서는 마크다운이고 저장할 때마다 git 커밋으로 남는다.
- 문서 경로는 「<묶음>/<종류>/<이름>」이다. 묶음은 회사의 업무 분야(예: 산사태)이고, 회사 전체가 같이 쓰는 용어 · 위키 사용법은 모든 묶음이 함께 보는 공유 묶음(예: 공통)에 있다. 있는 묶음은 list_pages 의 bundle 칸으로 본다.
- 종류 : 「<묶음>/개념/<이름>」은 용어 하나를 짧게 정리한 개념 문서, 「<묶음>/매뉴얼/<권>/<이름>」은 순서대로 읽는 업무 매뉴얼, 「<묶음>/틀/<이름>」은 다른 문서에 끼워 넣는 조각이다.
- 새 문서는 알맞은 묶음에 둔다. 여러 분야가 같은 뜻으로 쓰는 말만 공유 묶음에 두고, 분야마다 뜻이 다른 말은 각 묶음에 따로 둔다.
- 다른 문서는 [[제목]] 또는 [[제목|보일 글자]]로 잇는다. [[제목]] 은 같은 묶음 → 공유 묶음 순서로 찾는다. 다른 묶음의 문서는 [[<묶음>/제목]] 으로 잇는다. 개념 문서로 이은 말은 화면에서 마우스를 올리면 요약 카드가 뜬다. 요약은 본문 첫 문단(또는 첫 목록 항목)이므로 개념 문서는 첫 줄에 한 문장 정의를 둔다.
- search · retrieve · list_pages 에 bundle 을 주면 그 묶음과 공유 묶음에서만 찾는다. 한 분야 질문에 답할 때는 bundle 을 준다.
- 고치기 전에 read_page 로 지금 본문과 commit 을 받고, write_page 에 base_commit 으로 그 값을 넘긴다. 그 사이 누가 고쳤으면 저장하지 않고 알린다.
- search 는 낱말과 뜻을 함께 본다. 문서에 없는 말로 물어도 가까운 문서가 나올 수 있으니 결과의 본문을 read_page 로 확인한다.
- 질문에 위키 내용으로 답할 때는 retrieve 로 근거 단락을 받고, 답의 문장마다 그 단락의 url 을 근거로 단다. 근거 단락에 없는 내용은 지어내지 말고 위키에 없다고 말한다.
- 문서를 쓰거나 고치기 전에 style_guide 로 「글쓰기 표준」을, 그림을 만들기 전에 style_guide(topic: image)로 「그림 표준」을 읽고 그대로 따른다. 절 구성 · 어투 · 어휘 · 그림 화풍이 거기 있다.
- write_page 는 표준에서 어긋난 곳을 warnings 로 돌려준다. 경고가 있으면 고쳐서 다시 쓴다. 저장 전에 check_page 로 미리 볼 수도 있다.
- 소스 코드의 파일 이름 · 테이블 이름 같은 내부 식별자보다 개념 자체를 설명한다.
- 새 개념을 쓰면 write_page 응답의 mentions(또는 find_mentions)가 그 이름이 다른 문서에 링크 없이 나오는 곳을 준다. 이 개념을 가리키는 것만 골라 문서마다 처음 나온 곳을 [[ ]] 로 잇는다.";

// 표준의 정본은 위키 문서다. 표준을 고칠 때 서버를 고치지 않도록 여기서는 그 문서를 읽어 주기만 한다.
const GUIDES: [(&str, &str); 3] = [("writing", lint::GUIDE_WRITING), ("image", lint::GUIDE_IMAGE), ("terms", lint::GUIDE_TERMS)];

const VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn tools() -> Value {
    json!([
        { "name": "search", "title": "문서 찾기",
          "description": "제목 · 별칭 · 본문의 낱말과 뜻으로 문서를 찾는다. 띄어 쓴 낱말이 많이 겹칠수록, 뜻이 가까울수록 앞에 온다.",
          "inputSchema": { "type": "object", "properties": {
              "query": { "type": "string", "description": "찾을 말" },
              "bundle": { "type": "string", "description": "찾을 묶음(예: 산사태). 그 묶음과 공유 묶음에서만 찾는다. 없으면 위키 전체" },
              "limit": { "type": "integer", "minimum": 1, "maximum": 50 } }, "required": ["query"] } },
        { "name": "retrieve", "title": "근거 단락 찾기",
          "description": "질문에 답할 근거가 될 단락을 낱말 · 뜻 검색으로 찾는다. 단락마다 문서 · 단락 제목 · 글 · 인용 주소(url, 단락 앵커까지)를 준다. 문서 전체가 아니라 필요한 단락만 받으므로 답변 근거로 쓰기 좋다.",
          "inputSchema": { "type": "object", "properties": {
              "query": { "type": "string", "description": "질문이나 찾을 말. 문장 그대로 넣어도 된다" },
              "bundle": { "type": "string", "description": "찾을 묶음(예: 산사태). 그 묶음과 공유 묶음에서만 찾는다. 없으면 위키 전체" },
              "k": { "type": "integer", "minimum": 1, "maximum": 30, "description": "받을 단락 수(기본 8)" } }, "required": ["query"] } },
        { "name": "list_pages", "title": "문서 목록",
          "description": "문서의 경로 · 묶음 · 제목 · 종류 · 한 줄 요약.",
          "inputSchema": { "type": "object", "properties": {
              "kind": { "type": "string", "enum": ["concept", "manual", "page"], "description": "concept 개념 · manual 매뉴얼 · page 그 밖" },
              "bundle": { "type": "string", "description": "이 묶음과 공유 묶음 문서만. 없으면 위키 전체" } } } },
        { "name": "read_page", "title": "문서 읽기",
          "description": "문서 원문(머리말 포함)과 마지막 커밋을 준다. 경로 · 제목 · 별칭 어느 것으로도 찾는다.",
          "inputSchema": { "type": "object", "properties": {
              "name": { "type": "string", "description": "경로(산사태/개념/계류) · 「묶음/제목」(산사태/계류) · 제목 · 별칭" },
              "bundle": { "type": "string", "description": "제목 · 별칭으로 찾을 때 먼저 볼 묶음. 같은 이름의 문서가 여러 묶음에 있으면 넣는다" } }, "required": ["name"] } },
        { "name": "find_mentions", "title": "링크 안 된 언급 찾기",
          "description": "이 문서의 제목 · 별칭이 다른 문서 본문에 [[ ]] 없이 나오는 곳을 문서마다 첫 자리 하나(머리말을 뺀 본문의 줄 번호 · 그 줄 · 바꿀 링크)와 횟수로 준다. 고치지는 않는다. 새 개념을 쓴 뒤 골라서 그 문서마다 처음 나온 곳만 잇는다. 이미 이 문서로 이은 문서 · 코드 · 제목 줄 · 낫표 안 · 낱말 가운데 · 더 긴 다른 문서 이름의 일부는 뺀다.",
          "inputSchema": { "type": "object", "properties": {
              "name": { "type": "string", "description": "경로 · 「묶음/제목」 · 제목 · 별칭" },
              "bundle": { "type": "string", "description": "제목 · 별칭으로 찾을 때 먼저 볼 묶음" } }, "required": ["name"] } },
        { "name": "page_history", "title": "문서 이력",
          "description": "문서를 누가 언제 무엇이라 적고 고쳤는지.",
          "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
        { "name": "read_revision", "title": "지난 판 읽기",
          "description": "page_history 의 hash 로 그때의 원문을 준다.",
          "inputSchema": { "type": "object", "properties": { "path": { "type": "string" }, "rev": { "type": "string" } }, "required": ["path", "rev"] } },
        { "name": "recent_changes", "title": "최근 바뀐 것",
          "description": "위키 전체의 최근 커밋.",
          "inputSchema": { "type": "object", "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 100 } } } },
        { "name": "write_page", "title": "문서 쓰기",
          "description": "문서를 새로 만들거나 고친다. 이미 있는 문서를 고칠 때는 read_page 의 commit 을 base_commit 으로 꼭 넘긴다. 저장한 뒤 표준에서 어긋난 곳을 warnings 로 준다.",
          "inputSchema": { "type": "object", "properties": {
              "path": { "type": "string", "description": "<묶음>/개념/<이름> 또는 <묶음>/매뉴얼/<권>/<이름>. 예: 산사태/개념/유출구" },
              "title": { "type": "string", "description": "화면에 보일 제목" },
              "body": { "type": "string", "description": "마크다운 본문. 머리말(---)은 넣지 않는다" },
              "aliases": { "type": "array", "items": { "type": "string" }, "description": "이 문서를 가리키는 다른 이름" },
              "order": { "type": "number", "description": "매뉴얼 권 안 순서. 작을수록 앞" },
              "message": { "type": "string", "description": "무엇을 왜 바꿨는지 한 줄. 커밋 메시지가 된다" },
              "base_commit": { "type": ["string", "null"], "description": "read_page 로 받은 commit. 새 문서면 null" } },
            "required": ["path", "title", "body", "message"] } },
        { "name": "style_guide", "title": "표준 읽기",
          "description": "위키 기여 표준을 준다. writing 은 문서 종류별 뼈대 · 어투 · 어휘 · 표기, image 는 그림 종류 · 고정 화풍 프롬프트 · 색 규약. 쓰기 전에 읽는다.",
          "inputSchema": { "type": "object", "properties": {
              "topic": { "type": "string", "enum": ["writing", "image", "terms"], "description": "writing 글쓰기 표준 · image 그림 표준 · terms 용어 표준(쓰지 않는 말 → 표준어)" } }, "required": ["topic"] } },
        { "name": "check_page", "title": "표준 검사",
          "description": "저장하지 않고 본문이 글쓰기 표준에서 어긋난 곳(절 · 어투 · 기호 · 상투어 · 코드 이름 · 비표준어 · 그림 설명)을 줄 번호와 함께 돌려준다.",
          "inputSchema": { "type": "object", "properties": {
              "path": { "type": "string", "description": "쓸 경로(<묶음>/<종류>/…). 종류(개념 · 매뉴얼)를 여기서 가린다" },
              "body": { "type": "string", "description": "마크다운 본문. 머리말(---)은 넣지 않는다" } }, "required": ["path", "body"] } },
        { "name": "upload_image", "title": "그림 올리기",
          "description": "그림 · 움직이는 도식을 올리고 본문에 넣을 주소를 준다. 본문에는 ![설명](주소) 로 넣고, 바로 아래 줄에 *기울임* 으로 출처를 적는다. html 은 캔버스 애니메이션 · 시뮬레이션처럼 한 파일로 된 도식이고, 화면이 격리된 틀로 그린다(밖으로 요청하지 못하고 바깥 글꼴 · 라이브러리도 받지 못한다). 높이는 ![설명](주소 \"720\") 처럼 준다.",
          "inputSchema": { "type": "object", "properties": {
              "data_base64": { "type": "string", "description": "파일 내용(base64)" },
              "format": { "type": "string", "enum": ["png", "jpg", "gif", "webp", "html"], "description": "형식" } },
            "required": ["data_base64", "format"] } },
        { "name": "list_assets", "title": "자산 목록",
          "description": "올린 그림 · 움직이는 도식의 이름 · 주소 · 크기 · 쓰는 문서(used_by)를 준다. unused 가 true 면 아무 문서도 쓰지 않는 것만 준다(지울 후보).",
          "inputSchema": { "type": "object", "properties": {
              "unused": { "type": "boolean", "description": "쓰는 문서가 없는 것만" } } } },
        { "name": "delete_asset", "title": "자산 지우기",
          "description": "그림 · 움직이는 도식 하나를 지운다(커밋 하나 · 이력에서 되살릴 수 있다). 본문에 쓰는 문서가 있으면 거절한다. 사용자가 지우라고 할 때만 부른다.",
          "inputSchema": { "type": "object", "properties": {
              "name": { "type": "string", "description": "자산 이름(예: 43f8f3138ef1bc8b.html). 주소(/assets/…)를 줘도 된다" } },
            "required": ["name"] } }
    ])
}

fn text(v: &Value) -> Value {
    let t = match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap(),
    };
    json!({ "content": [{ "type": "text", "text": t }] })
}

fn fail(msg: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": msg.into() }], "isError": true })
}

fn arg_str<'a>(a: &'a Value, k: &str) -> Result<&'a str, Value> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| fail(format!("{k} 값(글자)이 필요합니다")))
}

/// bundle 인자. 없거나 「*」 이면 빈 글(위키 전체).
fn arg_bundle(a: &Value) -> String {
    a.get("bundle").and_then(Value::as_str).map(str::trim).filter(|b| *b != "*").unwrap_or("").to_string()
}

fn arg_limit(a: &Value, k: &str, max: u64, default: usize) -> usize {
    a.get(k).and_then(Value::as_u64).map(|n| n.clamp(1, max) as usize).unwrap_or(default)
}

async fn call(app: &Arc<App>, user: &User, name: &str, a: &Value) -> Result<Value, Value> {
    let err = |e: AppError| fail(e.message());
    match name {
        "search" => {
            let q = arg_str(a, "query")?.to_string();
            let limit = arg_limit(a, "limit", 50, 20);
            let scope = arg_bundle(a);
            let wiki = app.wiki();
            let hits = tokio::task::spawn_blocking(move || search::search(&wiki, &q, limit, &scope)).await.map_err(|e| fail(e.to_string()))?;
            let out: Vec<Value> =
                hits.iter().map(|h| json!({ "path": h.brief.path, "bundle": h.brief.bundle, "title": h.brief.title, "kind": h.brief.kind, "summary": h.brief.summary, "snippet": h.snippet })).collect();
            Ok(text(&json!(out)))
        }
        "retrieve" => {
            let q = arg_str(a, "query")?.to_string();
            let k = arg_limit(a, "k", 30, 8);
            let scope = arg_bundle(a);
            let wiki = app.wiki();
            let hits = tokio::task::spawn_blocking(move || search::retrieve(&wiki, &q, k, &scope)).await.map_err(|e| fail(e.to_string()))?;
            let out: Vec<Value> = hits.iter().map(|h| json!({ "url": h.url, "path": h.path, "title": h.title, "heading": h.heading, "text": h.text })).collect();
            Ok(text(&json!(out)))
        }
        "list_pages" => {
            let kind = a.get("kind").and_then(Value::as_str);
            let scope = arg_bundle(a);
            let wiki = app.wiki();
            let list: Vec<_> = wiki.all().filter(|p| kind.is_none_or(|k| p.kind == k) && wiki.in_scope(&p.path, &scope)).map(|p| p.brief()).collect();
            Ok(text(&json!(list)))
        }
        "read_page" => {
            let name = arg_str(a, "name")?;
            let wiki = app.wiki();
            let p = if wiki.get(name).is_some() { Some(name) } else { wiki.resolve(name, &arg_bundle(a)) };
            let Some(p) = p else {
                let many = wiki.candidates(name);
                return Err(fail(if many.len() > 1 {
                    format!("「{name}」 문서가 여러 묶음에 있습니다 : {}. 경로로 읽거나 bundle 을 넣어 주세요.", many.join(" · "))
                } else {
                    format!("「{name}」 문서가 없습니다. search 로 찾아보세요.")
                }));
            };
            let source = store::read(p).await;
            let commit = store::last_commit(p).await.map_err(|e| err(e.into()))?;
            let backlinks: Vec<String> = wiki.backlinks(p).into_iter().map(|b| b.path).collect();
            Ok(text(&json!({ "path": p, "commit": commit, "backlinks": backlinks, "source": source })))
        }
        "find_mentions" => {
            let name = arg_str(a, "name")?;
            let wiki = app.wiki();
            let p = if wiki.get(name).is_some() { Some(name) } else { wiki.resolve(name, &arg_bundle(a)) };
            let Some(p) = p else { return Err(fail(format!("「{name}」 문서가 없습니다. 경로로 넣어 주세요."))) };
            Ok(text(&json!({ "path": p, "mentions": wiki.mentions(p) })))
        }
        "page_history" => {
            let p = store::safe_path(arg_str(a, "path")?).map_err(|e| err(e.into()))?;
            let h = store::history(&p, 50).await.map_err(|e| err(e.into()))?;
            let out: Vec<Value> = h.iter().map(|c| json!({ "hash": c.hash, "author": c.author, "date": c.date, "subject": c.subject })).collect();
            Ok(text(&json!(out)))
        }
        "read_revision" => {
            let p = store::safe_path(arg_str(a, "path")?).map_err(|e| err(e.into()))?;
            match store::read_at(&p, arg_str(a, "rev")?).await.map_err(err)? {
                Some(t) => Ok(text(&Value::String(t))),
                None => Err(fail("그 판에는 이 문서가 없습니다")),
            }
        }
        "recent_changes" => {
            let r = store::recent(arg_limit(a, "limit", 100, 20)).await.map_err(|e| err(e.into()))?;
            Ok(text(&json!(r)))
        }
        "write_page" => {
            let p = store::safe_path(arg_str(a, "path")?).map_err(|e| err(e.into()))?;
            let (title, body, message) = (arg_str(a, "title")?, arg_str(a, "body")?, arg_str(a, "message")?);
            let base = a.get("base_commit").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
            let old = app.wiki().get(&p).map(|pg| pg.meta.clone());
            let exists = old.is_some();
            if exists && base.is_none() {
                return Err(fail("이미 있는 문서입니다. read_page 로 commit 을 받아 base_commit 으로 넘기세요."));
            }
            if !exists {
                pages::check_new_path(&p).map_err(fail)?;
            }
            let mut meta = old.unwrap_or_default();
            meta.insert("title".into(), json!(title));
            if let Some(al) = a.get("aliases").filter(|v| v.is_array()) {
                meta.insert("aliases".into(), al.clone());
            }
            if let Some(o) = a.get("order").filter(|v| v.is_number()) {
                meta.insert("order".into(), o.clone());
            }
            // 별칭을 넘기지 않으면 머리말의 것을 그대로 쓰므로, 겹침 검사도 저장될 별칭으로 한다.
            let aliases: Vec<String> = match meta.get("aliases") {
                Some(Value::Array(v)) => v.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect(),
                _ => vec![],
            };
            if let Some(m) = app.wiki().name_clash(&p, title, &aliases) {
                return Err(fail(m));
            }
            let warnings = lint::lint(&app.wiki(), &p, body);
            let r = store::write(&p, &stringify(&meta, body), user, &format!("{message} (MCP)"), Some(if exists { base } else { None })).await;
            match r {
                Ok(r) => {
                    app.reload().await.map_err(|e| err(e.into()))?;
                    let mut out = json!({ "path": p, "commit": r.commit, "unchanged": r.unchanged, "warnings": warnings });
                    // 새 문서면 옛 문서에 맨글로 남은 같은 말을 함께 알린다. 잇는 것은 쓰는 쪽이 골라서 한다(find_mentions).
                    if !exists {
                        let m = app.wiki().mentions(&p);
                        if !m.is_empty() {
                            out["mentions"] = json!(m);
                            out["mentions_hint"] = json!("다른 문서에 이 문서의 이름이 링크 없이 나옵니다. 맞는 것만 골라 그 문서마다 처음 나온 곳을 [[ ]] 로 이어 주세요.");
                        }
                    }
                    Ok(text(&out))
                }
                Err(e) if e.status() == Some(409) => Err(fail(format!("{}. read_page 로 다시 읽고 고쳐 주세요.", e.message()))),
                Err(e) => Err(err(e)),
            }
        }
        "style_guide" => {
            let topic = arg_str(a, "topic")?;
            let Some((_, p)) = GUIDES.iter().find(|(t, _)| *t == topic) else { return Err(fail("topic 은 writing · image · terms 가운데 하나입니다")) };
            match store::read(p).await {
                Some(src) => Ok(text(&Value::String(src))),
                None => Err(fail(format!("「{p}」 문서가 아직 없습니다. 표준 없이 쓰지 말고 위키 관리자에게 알려 주세요."))),
            }
        }
        "check_page" => {
            let p = store::safe_path(arg_str(a, "path")?).map_err(|e| err(e.into()))?;
            let warnings = lint::lint(&app.wiki(), &p, arg_str(a, "body")?);
            Ok(text(&json!({ "path": p, "warnings": warnings })))
        }
        "upload_image" => {
            let data: String = arg_str(a, "data_base64")?.chars().filter(|c| !c.is_whitespace()).collect();
            let format = arg_str(a, "format")?;
            if !["png", "jpg", "gif", "webp", "html"].contains(&format) {
                return Err(fail("format 은 png · jpg · gif · webp · html 가운데 하나입니다"));
            }
            let buf = decode_base64(&data).ok_or_else(|| fail("그림 내용(base64)을 읽지 못했습니다"))?;
            if buf.is_empty() {
                return Err(fail("그림 내용이 비었습니다"));
            }
            if buf.len() > 15 * 1024 * 1024 {
                return Err(fail("15MB 넘는 그림은 줄여서 올려 주세요"));
            }
            // 화면 올리기와 같은 이름 규칙 : 내용 해시라 같은 그림을 두 번 올려도 한 장만 남는다.
            let name = format!("{}.{format}", &hex::encode(Sha256::digest(&buf))[..16]);
            store::save_asset(&name, &buf, user).await.map_err(err)?;
            Ok(text(&json!({ "url": format!("/assets/{name}") })))
        }
        "list_assets" => {
            let unused = a.get("unused").and_then(Value::as_bool).unwrap_or(false);
            let all = crate::api::assets_report(app).await.map_err(|e| err(e.into()))?;
            let out: Vec<Value> = all.into_iter().filter(|v| !unused || v["used_by"].as_array().is_some_and(|u| u.is_empty())).collect();
            Ok(text(&json!(out)))
        }
        "delete_asset" => {
            let raw = arg_str(a, "name")?;
            let name = raw.trim().trim_start_matches("/assets/");
            let w = crate::api::remove_asset(app, user, name).await.map_err(err)?;
            Ok(text(&json!(w)))
        }
        _ => Err(fail(format!("모르는 도구입니다 : {name}"))),
    }
}

/// base64 를 너그럽게 읽는다 : 표준 · URL-safe 글자, 채움 문자(=) 있고 없음, 끝 비트가 0 이 아닌 것까지.
/// Node 판(Buffer.from(…, 'base64'))이 이것들을 다 받았고, 도구마다 내보내는 꼴이 달라서다.
fn decode_base64(data: &str) -> Option<Vec<u8>> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    let engine = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent));
    let s: String = data.trim_end_matches('=').chars().map(|c| match c {
        '-' => '+',
        '_' => '/',
        c => c,
    }).collect();
    engine.decode(s).ok()
}

/// Authorization 머리글에서 토큰을 꺼낸다. 「Bearer」는 대소문자를 가리지 않는다(HTTP 인증 방식 이름은 대소문자 무관).
pub fn bearer(h: &str) -> String {
    let h = h.trim();
    match h.split_once(char::is_whitespace) {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("bearer") => rest.trim().to_string(),
        _ => h.to_string(),
    }
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// JSON-RPC 메시지 하나. 알림(id 없음)이면 None — 돌려줄 것이 없다.
async fn dispatch(app: &Arc<App>, user: &User, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if VERSIONS.contains(&asked) { asked } else { VERSIONS[1] };
            ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "company-wiki", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let r = call(app, user, name, &args).await.unwrap_or_else(|e| e);
            ok(id, r)
        }
        _ => rpc_error(id, -32601, "모르는 메서드입니다"),
    })
}

pub async fn handle(app: Arc<App>, headers: HeaderMap, body: Bytes) -> Response {
    let token = bearer(headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or(""));
    let Some(user) = auth::user_from_token(&token) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "위키 계정 화면에서 MCP 토큰을 만들어 Authorization: Bearer <토큰> 으로 붙여 주세요" }))).into_response();
    };
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(rpc_error(Value::Null, -32700, "JSON 을 읽지 못했습니다"))).into_response();
    };
    // 묶음(배열)은 2025-06-18 판에서 빠졌지만, 옛 판으로 붙는 도구를 위해 하나씩 처리해 묶어 돌려준다.
    let out = match &msg {
        Value::Array(list) => {
            let mut res = Vec::new();
            for m in list {
                res.extend(dispatch(&app, &user, m).await);
            }
            (!res.is_empty()).then(|| Value::Array(res))
        }
        m => dispatch(&app, &user, m).await,
    };
    match out {
        Some(v) => Json(v).into_response(),
        None => StatusCode::ACCEPTED.into_response(), // 알림(notifications/initialized 등)
    }
}
