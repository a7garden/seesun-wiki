// 문서 목록과 그 위의 계산 : 제목 · 별칭으로 찾기, 미리보기 요약, 역링크, 매뉴얼 차례.
// 문서가 수천 장을 넘지 않는다고 보고 저장할 때마다 통째로 다시 읽는다(검색 색인도 함께 새로 만든다).
//
// 문서 경로는 「묶음/종류/이름」이다 — 산사태/개념/유출구 · 공통/매뉴얼/위키 사용법/글쓰기 표준.
// 2026.11.09 : 회사의 여러 사업 분야가 한 위키를 쓰므로 맨 앞에 묶음을 두었다. 분야마다 같은 이름의 용어
//              (「위기경보」 · 「대피소」)가 뜻이 달라, 종류만으로 나누면 한 위키에 둘을 함께 둘 수 없었다.
//
// 목차
//   0. 묶음      : 묶음 이름 · 종류 폴더 · 새 문서 경로 검사
//   1. 문서 하나 : Page · 종류 · 마크다운 벗기기(표는 「항목: 값」 글로) · 요약
//   2. 단락      : 「## · ###」로 나눈 단락(RAG · 임베딩 단위) · 화면과 같은 제목 앵커(Slugger)
//   3. 위키 전체 : Wiki — 문서 목록 · 이름 찾기(묶음 → 공유 묶음 → 다른 묶음) · 역링크 · 링크 지도 · 매뉴얼 차례 · 단락 목록(Chunk)
use crate::bundles::Registry;
use crate::frontmatter::{self, Meta};
use crate::search;
use crate::store;
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

pub static WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]").unwrap());
// 2026.11.11 : ~~~ 펜스도 코드로 본다. 「그림 표준」이 mermaid 예시를 ~~~ 로 감싸 그 안의 링크 · 그림이 진짜로 세어졌다.
static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```|~~~.*?~~~|`[^`\n]*`").unwrap());
static IMG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap());
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_`~]+").unwrap());
static LIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*[-+]\s+|^\s*\d+\.\s+|^>\s?").unwrap());
static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[-+*]\s").unwrap());
static CAPTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\*[^*].*\*$").unwrap());
// 「![[문서]]」 끼워 넣기는 화면이 그 문서를 그려 넣는다. 검색 · 임베딩 글에서는 앞의 「!」만 떼고 이름을 남긴다 —
// 끼운 글은 원래 문서에서만 센다(여러 문서에 끼운 틀이 검색 결과를 같은 글로 채우지 않게).
static EMBED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!(\[\[)").unwrap());
// 「[목차]」 한 줄은 화면이 차례로 바꾼다. 글로 남기면 모든 매뉴얼 단락에 「목차」가 섞인다.
static TOC_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^[ \t]*\[목차\][ \t]*$").unwrap());
static TABLE_RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$").unwrap());
// 링크 안 된 언급을 셀 때 보지 않는 자리 : 코드 · 위키 링크 · 마크다운 링크 · 낫표 안 · 주소 · HTML 태그.
static MASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`|!?\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\)|「[^」]*」|https?://\S+|<[^>]+>").unwrap());
static IMAGE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^!\[").unwrap());

/// 글자 단위 소문자. 견줄 때 글자 자리를 원문과 맞추려고 글자 하나를 글자 하나로만 바꾼다.
fn lower(s: &str) -> Vec<char> {
    s.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

static FIRST_IMG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\(([^)\s]+)").unwrap());

// ── 0. 묶음

// 2026.11.10 : 「공통」을 코드에 박아 두던 것을 묶음 목록(bundles.json)의 공유 표시로 옮겼다 — Wiki::shared · bundles.rs.
/// 종류 폴더 이름. 묶음 이름으로 쓰지 못한다 — 그러면 [[개념/계류]] · [[틀/주의]] 가 「개념」 · 「틀」 묶음으로 읽힌다.
pub const KINDS: [&str; 3] = ["개념", "매뉴얼", "틀"];

/// 경로의 묶음 : 맨 앞 폴더. 폴더가 없는 문서(옛 꼴)는 빈 글.
pub fn bundle_of(p: &str) -> &str {
    p.split_once('/').map(|(b, _)| b).unwrap_or("")
}

/// 묶음 안 경로 : 개념/유출구. [[개념/유출구]] 처럼 묶음을 빼고 이을 때 찾는 열쇠다.
fn in_bundle(p: &str) -> &str {
    p.split_once('/').map(|(_, r)| r).unwrap_or(p)
}

/// 다른 문서에 끼워 넣을 조각(<묶음>/틀/<이름>). 왼쪽 목록에 늘어놓지 않는다.
pub fn is_template(p: &str) -> bool {
    let parts: Vec<&str> = p.split('/').collect();
    parts.len() > 2 && parts[1] == "틀"
}

/// 새 문서 경로가 「묶음/…」 꼴인지. 이미 있는 문서는 검사하지 않는다(옛 경로도 고칠 수는 있게).
pub fn check_new_path(p: &str) -> Result<(), String> {
    let parts: Vec<&str> = p.split('/').collect();
    let eg = "예: 산사태/개념/유출구 · 공통/매뉴얼/위키 사용법/위키 읽는 법";
    if parts.len() < 2 {
        return Err(format!("문서 경로 맨 앞에 묶음을 넣어 주세요 ({eg})"));
    }
    if KINDS.contains(&parts[0]) {
        return Err(format!("「{}」은 종류 이름이라 묶음으로 쓸 수 없습니다. 묶음을 맨 앞에 넣어 주세요 ({eg})", parts[0]));
    }
    Ok(())
}

#[derive(Clone)]
pub struct Page {
    pub path: String,
    pub title: String,
    pub kind: &'static str,
    pub aliases: Vec<String>,
    pub order: Value, // 숫자. 매뉴얼 권 안 순서 · 없으면 1000
    pub summary: String,
    pub image: Option<String>,
    pub links: Vec<String>,
    pub meta: Meta,
    pub body: String,
    pub sections: Vec<Section>,
}

/// 문서의 한 단락 : 「## 」 · 「### 」 제목 아래 글. 검색 · 임베딩 · 답변 근거(RAG)의 단위다.
/// 제목 앞 글(머리 단락)은 heading · anchor 가 비어 있다.
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub heading: String, // 「상위 › 하위」 꼴의 제목 경로
    pub anchor: String,  // 화면이 붙이는 제목 id (rehype-slug). 인용 링크 /w/<경로>#<anchor>
    pub text: String,    // 마크다운을 벗긴 글
}

/// 단락 하나가 이보다 길면 문단 경계에서 나눈다. 임베딩 모델 입력 상한(토큰)을 넘기지 않고,
/// 답변 근거로 넘길 때도 한 조각이 너무 길지 않게.
const SECTION_MAX: usize = 1200;

static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$").unwrap());
static HEADING_MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*|\*|`|~~").unwrap());

/// github-slugger(화면의 rehype-slug)와 같은 꼴 : 소문자로 바꾸고, 글자 · 숫자 · - · _ · 띄어쓰기만 남기고, 띄어쓰기는 - 로.
/// 같은 id 가 거듭 나오면 -1, -2 를 붙인다. 어긋나면 인용 링크가 문서 맨 위로 떨어진다(깨지지는 않는다).
pub struct Slugger(HashMap<String, usize>);

impl Slugger {
    pub fn new() -> Self {
        Slugger(HashMap::new())
    }
    pub fn slug(&mut self, text: &str) -> String {
        let base: String = text.to_lowercase().chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ')).map(|c| if c == ' ' { '-' } else { c }).collect();
        let mut out = base.clone();
        while self.0.contains_key(&out) {
            let n = self.0.get_mut(&base).map(|n| {
                *n += 1;
                *n
            });
            out = format!("{base}-{}", n.unwrap_or(1));
        }
        self.0.insert(out.clone(), 0);
        out
    }
}

/// 화면에 보이는 제목 글자 : 링크는 보일 글자로, 강조 · 코드 표시는 뗀다.
fn heading_text(md: &str) -> String {
    let s = WIKILINK.replace_all(md, |c: &regex::Captures| c.get(2).or(c.get(1)).unwrap().as_str().to_string());
    let s = IMG.replace_all(&s, "");
    let s = LINK.replace_all(&s, "$1");
    HEADING_MARKS.replace_all(&s, "").trim().to_string()
}

pub fn sections(body: &str) -> Vec<Section> {
    let mut slugger = Slugger::new();
    let mut out: Vec<(String, String, Vec<&str>)> = vec![(String::new(), String::new(), vec![])];
    let mut h2 = String::new();
    let mut fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            fence = !fence;
        }
        let head = if fence { None } else { HEADING.captures(line) };
        let Some(h) = head else {
            out.last_mut().unwrap().2.push(line);
            continue;
        };
        let level = h[1].len();
        let text = heading_text(&h[2]);
        let anchor = slugger.slug(&text); // 모든 제목이 id 순번을 먹으므로 # · #### 도 센다
        match level {
            2 => {
                h2 = text.clone();
                out.push((text, anchor, vec![]));
            }
            3 => {
                let path = if h2.is_empty() { text } else { format!("{h2} › {text}") };
                out.push((path, anchor, vec![]));
            }
            // # · #### 이하는 단락을 나누지 않고 제목 글자만 글로 둔다(「#」 표시가 검색 · 임베딩 글에 섞이지 않게)
            _ => out.last_mut().unwrap().2.push(h.get(2).unwrap().as_str()),
        }
    }
    let mut res = Vec::new();
    for (heading, anchor, lines) in out {
        // 긴 단락은 빈 줄(문단) 경계에서 SECTION_MAX 안쪽으로 나눈다. 나뉜 조각은 같은 제목 · 앵커를 쓴다.
        let mut part = String::new();
        for para in BLANK.split(&lines.join("\n")) {
            let p = plain(para);
            if p.is_empty() {
                continue;
            }
            if !part.is_empty() && part.chars().count() + p.chars().count() > SECTION_MAX {
                res.push(Section { heading: heading.clone(), anchor: anchor.clone(), text: std::mem::take(&mut part) });
            }
            if !part.is_empty() {
                part.push(' ');
            }
            part.push_str(&p);
        }
        if !part.is_empty() {
            res.push(Section { heading, anchor, text: part });
        }
    }
    res
}

#[derive(Serialize, Clone)]
pub struct Brief {
    pub path: String,
    pub bundle: String,
    pub title: String,
    pub kind: &'static str,
    pub summary: String,
    pub image: Option<String>,
    pub aliases: Vec<String>,
    pub order: Value,
}

impl Page {
    pub fn brief(&self) -> Brief {
        Brief {
            path: self.path.clone(),
            bundle: bundle_of(&self.path).to_string(),
            title: self.title.clone(),
            kind: self.kind,
            summary: self.summary.clone(),
            image: self.image.clone(),
            aliases: self.aliases.clone(),
            order: self.order.clone(),
        }
    }
    /// 매뉴얼 권 이름 : <묶음>/매뉴얼/<권>/<문서> 의 <권>. 매뉴얼이 아니거나 권이 없으면 빈 글.
    pub fn volume(&self) -> &str {
        let parts: Vec<&str> = self.path.split('/').collect();
        if self.kind == "manual" && parts.len() > 3 { parts[2] } else { "" }
    }
    pub fn bundle(&self) -> &str {
        bundle_of(&self.path)
    }
    fn order_f(&self) -> f64 {
        self.order.as_f64().unwrap_or(1000.0)
    }
}

/// 묶음 다음 폴더가 문서 종류를 정한다(<묶음>/개념/<이름>). 머리말 type 으로 바꿀 수 있다.
pub fn kind_of(p: &str, meta: &Meta) -> &'static str {
    match meta.get("type").and_then(Value::as_str) {
        Some("concept" | "개념") => return "concept",
        Some("manual" | "매뉴얼") => return "manual",
        _ => {}
    }
    let parts: Vec<&str> = p.split('/').collect();
    match parts.get(1).filter(|_| parts.len() > 2).copied() {
        Some("개념") => "concept",
        Some("매뉴얼") => "manual",
        _ => "page",
    }
}

/// 마크다운을 벗긴 글. 요약 · 검색 조각 · 임베딩에 쓴다.
pub fn plain(md: &str) -> String {
    let s = TOC_MARK.replace_all(md, "");
    let s = EMBED.replace_all(&s, "$1");
    let s = WIKILINK.replace_all(&s, |c: &regex::Captures| c.get(2).or(c.get(1)).unwrap().as_str().to_string());
    let s = IMG.replace_all(&s, "");
    let s = LINK.replace_all(&s, "$1");
    let s = tables(&s);
    let s = MARKS.replace_all(&s, "");
    let s = LIST.replace_all(&s, "");
    WS.replace_all(&s, " ").trim().to_string()
}

/// 표를 줄마다 「머리칸: 값 · 머리칸: 값」 글로 편다. 그대로 두면 「| 규칙 | 보는 것 | |---|---|」 같은 기호가
/// 임베딩 · 검색 글에 섞여 표가 많은 매뉴얼일수록 뜻 검색이 흐려진다(2026.11.09 실측).
/// 링크는 먼저 벗겨 두어야 한다 — 「[[가\|나]]」의 「|」를 칸 경계로 잘못 자른다.
fn tables(md: &str) -> String {
    let cells = |l: &str| -> Vec<String> {
        let t = l.trim().trim_start_matches('|');
        let t = t.strip_suffix('|').filter(|x| !x.ends_with('\\')).unwrap_or(t);
        let mut out = vec![String::new()];
        let mut esc = false;
        for c in t.chars() {
            match c {
                '|' if !esc => out.push(String::new()),
                '\\' if !esc => esc = true,
                _ => {
                    if esc && c != '|' {
                        out.last_mut().unwrap().push('\\');
                    }
                    esc = false;
                    out.last_mut().unwrap().push(c);
                }
            }
        }
        out.into_iter().map(|x| x.trim().to_string()).collect()
    };
    let lines: Vec<&str> = md.lines().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        // 머리 줄 바로 아래 「|---|」 줄이 있어야 표다. 그냥 「|」로 시작하는 글은 건드리지 않는다.
        if !(l.trim_start().starts_with('|') && lines.get(i + 1).is_some_and(|n| n.contains('-') && TABLE_RULE.is_match(n.trim()))) {
            out.push(l.to_string());
            i += 1;
            continue;
        }
        let head = cells(l);
        i += 2;
        while i < lines.len() && lines[i].trim_start().starts_with('|') {
            let row: Vec<String> = cells(lines[i])
                .into_iter()
                .enumerate()
                .filter(|(_, v)| !v.is_empty())
                .map(|(k, v)| match head.get(k).filter(|h| !h.is_empty()) {
                    Some(h) => format!("{h}: {v}"),
                    None => v,
                })
                .collect();
            out.push(row.join(" · "));
            i += 1;
        }
    }
    out.join("\n")
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 미리보기 카드에 넣을 첫 설명. 제목 · 그림 · 그림 설명 줄 · 표는 건너뛴다.
fn summarize(body: &str) -> String {
    for b in BLANK.split(body) {
        let t = b.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with('|') || t.starts_with("```") || t.starts_with("![") || CAPTION.is_match(t) {
            continue;
        }
        // 목록이면 첫 항목만. 정의 목록의 첫 줄이 대개 한 문장 정의다.
        let first = if ITEM.is_match(t) { first_item(t) } else { t };
        let s = plain(first);
        let n = s.chars().count();
        if n > 4 {
            return if n > 240 { format!("{}…", cut(&s, 238)) } else { s };
        }
    }
    String::new()
}

fn first_item(t: &str) -> &str {
    for (i, _) in t.match_indices('\n') {
        if ITEM.is_match(&t[i + 1..]) {
            return &t[..i];
        }
    }
    t
}

pub fn to_page(p: &str, text: &str) -> Page {
    let (meta, body) = frontmatter::parse(text);
    let name = p.rsplit('/').next().unwrap_or(p);
    // 코드 안의 [[ ]] 는 쓰는 법 예시라 링크로 세지 않는다.
    let prose = CODE.replace_all(&body, "");
    let links = WIKILINK.captures_iter(&prose).map(|c| c[1].trim().to_string()).collect();
    let aliases = match meta.get("aliases") {
        Some(Value::Array(a)) => a.iter().map(show).collect(),
        Some(Value::Null) | None => vec![],
        Some(v) => vec![show(v)],
    };
    let title = match meta.get("title") {
        Some(v) if !matches!(v, Value::Null) && !show(v).is_empty() => show(v),
        _ => name.to_string(),
    };
    Page {
        path: p.to_string(),
        sections: sections(&body),
        kind: kind_of(p, &meta),
        order: meta.get("order").filter(|v| v.is_number()).cloned().unwrap_or(json!(1000)),
        summary: summarize(&body),
        // 2026.11.11 : 코드를 벗긴 본문에서, html 도식은 빼고 고른다. 카드 · 개념 목록이 이 값을 <img> 로 그려
        //   쓰는 법 예시(`![..](/assets/….html)`)나 움직이는 도식이 잡히면 요약 그림이 깨진다.
        image: FIRST_IMG.captures_iter(&prose).map(|c| c[1].to_string()).find(|u| !u.split('#').next().unwrap_or(u).ends_with(".html")),
        title,
        aliases,
        links,
        meta,
        body,
    }
}

/// 한국어 사전 순서에 가깝게 견주는 키 : 띄어쓰기 · 기호 → 숫자 → 한글 → 한자 → 영문(대소문자 무시).
/// Node 판(localeCompare 'ko')과 개념 목록 순서를 같게 하려고 둔다. 코드 순서로 견주면 영문이 한글 앞에 온다.
/// 다른 점 하나 : ICU 는 한자를 한글 읽기 자리에 끼운다(溪流 → 계류 옆). 읽기 사전이 없어 여기서는 한글 뒤로 모은다.
pub fn ko_key(s: &str) -> Vec<(u8, String)> {
    s.chars()
        .map(|c| {
            let rank = match c as u32 {
                _ if c.is_ascii_digit() => 1,
                0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F => 2,
                0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF => 3,
                _ if c.is_alphanumeric() => 4,
                _ => 0,
            };
            (rank, c.to_lowercase().collect())
        })
        .collect()
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 위키 전체의 단락 하나. Wiki::chunks() 의 자리(번호)가 그 목록 안의 id 다 — 목록을 새로 만들면 번호도 바뀐다.
#[derive(Clone, Debug)]
pub struct Chunk {
    pub path: String,
    pub bundle: String,
    pub title: String,
    pub volume: String, // 매뉴얼 권 이름. 매뉴얼이 아니면 비어 있다
    pub heading: String,
    pub anchor: String,
    pub text: String,
}

impl Chunk {
    /// 화면 주소. 답변에 근거로 달 링크다.
    pub fn url(&self) -> String {
        // 화면의 pageUrl(encodeURIComponent)과 같은 꼴 : 앵커의 「-」 등을 %2D 로 바꾸지 않는다.
        const URI_COMPONENT: &percent_encoding::AsciiSet =
            &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
        let enc = |s: &str| percent_encoding::utf8_percent_encode(s, URI_COMPONENT).to_string();
        let base = format!("/w/{}", self.path.split('/').map(enc).collect::<Vec<_>>().join("/"));
        if self.anchor.is_empty() { base } else { format!("{base}#{}", enc(&self.anchor)) }
    }
}

pub struct Wiki {
    pages: BTreeMap<String, Page>,
    by_path: HashMap<String, String>,                  // 경로(소문자) → 경로
    by_name: HashMap<String, HashMap<String, String>>, // 묶음 → (제목 · 별칭 · 이름 · 묶음 안 경로(소문자) → 경로)
    pub index: search::Index,
    chunks: Vec<Chunk>,
    pub chunk_index: search::ChunkIndex,
    pub registry: Registry,
    shared: Vec<String>, // 공유 묶음. 목록 차례대로
}

impl Wiki {
    pub async fn load() -> anyhow::Result<Wiki> {
        let mut pages = BTreeMap::new();
        for p in store::list_files().await? {
            if let Some(text) = store::read(&p).await {
                pages.insert(p.clone(), to_page(&p, &text));
            }
        }
        let (by_path, by_name) = name_maps(&pages);
        let index = search::Index::build(pages.values())?;
        let chunks: Vec<Chunk> = pages
            .values()
            .flat_map(|pg| {
                let (bundle, volume) = (pg.bundle().to_string(), pg.volume().to_string());
                pg.sections.iter().map(move |s| Chunk {
                    path: pg.path.clone(),
                    bundle: bundle.clone(),
                    title: pg.title.clone(),
                    volume: volume.clone(),
                    heading: s.heading.clone(),
                    anchor: s.anchor.clone(),
                    text: s.text.clone(),
                })
            })
            .collect();
        let chunk_index = search::ChunkIndex::build(&chunks)?;
        let registry = store::read_registry().await;
        let shared = registry.shared();
        Ok(Wiki { pages, by_path, by_name, index, chunks, chunk_index, registry, shared })
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    pub fn get(&self, p: &str) -> Option<&Page> {
        self.pages.get(p)
    }
    pub fn all(&self) -> impl Iterator<Item = &Page> {
        self.pages.values()
    }
    /// 이 자산(그림 · 움직이는 도식)을 본문에 쓰는 문서 경로. 자산 이름이 내용의 해시라 이름만으로 찾아도 겹치지 않는다.
    pub fn asset_users(&self, name: &str) -> Vec<String> {
        let needle = format!("/assets/{name}");
        self.pages.values().filter(|p| p.body.contains(&needle)).map(|p| p.path.clone()).collect()
    }
    pub fn len(&self) -> usize {
        self.pages.len()
    }

    /// 공유 묶음 : 어느 묶음을 보든 함께 보이고, [[이름]] 이 지금 묶음에 없으면 찾아보는 묶음.
    pub fn shared(&self) -> &[String] {
        &self.shared
    }
    pub fn is_shared(&self, b: &str) -> bool {
        self.shared.iter().any(|s| s == b)
    }
    /// 검색 범위 : scope 가 비었으면 위키 전체, 아니면 그 묶음과 공유 묶음.
    pub fn in_scope(&self, p: &str, scope: &str) -> bool {
        scope.is_empty() || matches!(bundle_of(p), b if b == scope || self.is_shared(b))
    }

    /// [[이름]] 이 가리키는 문서. from 은 링크를 쓴 문서의 묶음이다. 찾는 차례 :
    ///   1. 전체 경로(산사태/개념/유출구)
    ///   2. 「묶음/이름」(산사태/유출구 · 산사태/개념/유출구) — 앞 조각이 있는 묶음 이름일 때
    ///   3. 지금 묶음 → 공유 묶음(목록 차례) 에서 제목 · 별칭 · 이름 · 묶음 안 경로(개념/유출구)
    ///   4. 다른 묶음 — 그 이름의 문서가 위키 전체에 하나뿐일 때만. 둘 이상이면 고르지 않는다(묶음을 붙여 이어야 한다)
    pub fn resolve(&self, name: &str, from: &str) -> Option<&str> {
        let n = name.trim().to_lowercase();
        if let Some(p) = self.by_path.get(&n) {
            return Some(p);
        }
        if let Some((head, rest)) = n.split_once('/')
            && let Some(p) = self.by_name.get(head.trim()).and_then(|m| m.get(rest.trim()))
        {
            return Some(p);
        }
        for b in std::iter::once(from).chain(self.shared.iter().map(String::as_str)) {
            if let Some(p) = self.by_name.get(&b.to_lowercase()).and_then(|m| m.get(&n)) {
                return Some(p);
            }
        }
        match self.candidates(&n).as_slice() {
            [one] => Some(one),
            _ => None,
        }
    }

    /// 이 문서의 이름(제목 · 별칭 · 파일 이름)이 다른 문서 본문에 링크 없이 나오는 곳. 문서마다 첫 자리 하나와 횟수.
    /// 새 개념을 쓴 뒤 옛 문서의 같은 말을 [[ ]] 로 이을 후보다. 고치지는 않는다 — 고를지는 쓰는 사람이 본다.
    /// 화면에서 자동으로 잇지 않는 까닭 : 한국어는 낱말 끝을 가를 수 없어(「계류」 · 「계류보전」) 잘못 이은 링크가 생긴다.
    ///   - 그 문서에서 [[이름]] 이 이 문서로 가는 경우만 센다(다른 묶음의 같은 이름 · 이미 이 문서로 이은 문서는 뺀다)
    ///   - 코드 · 제목 줄 · 그림 · 이미 있는 링크 · 낫표 「」 안 · 주소는 보지 않는다
    ///   - 앞 글자가 글자 · 숫자면(낱말 가운데) 빼고, 같은 자리에서 더 긴 다른 문서 이름이 맞으면(계류 → 계류보전) 뺀다
    /// 2026.11.09 : 새 개념을 넣어도 옛 문서의 같은 말이 맨글로 남아 요약 카드 · 역링크에 잡히지 않았다.
    pub fn mentions(&self, target: &str) -> Vec<Value> {
        let Some(tp) = self.get(target) else { return vec![] };
        let mut names: Vec<String> = vec![tp.title.clone(), target.rsplit('/').next().unwrap().to_string()];
        names.extend(tp.aliases.iter().cloned());
        let mut names: Vec<Vec<char>> = names.iter().map(|n| lower(n.trim())).filter(|n| n.len() >= 2).collect();
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));
        names.dedup();
        let all: Vec<Vec<char>> = self.by_name.values().flat_map(|m| m.keys()).map(|k| lower(k)).collect();
        let mut out = vec![];
        for o in self.all().filter(|o| o.path != target) {
            if o.links.iter().any(|l| self.resolve(l, o.bundle()) == Some(target)) {
                continue;
            }
            let mut first: Option<(usize, String, String)> = None;
            let mut count = 0;
            let mut fence = false;
            for (i, line) in o.body.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("```") || t.starts_with("~~~") {
                    fence = !fence;
                    continue;
                }
                if fence || t.starts_with('#') || IMAGE_LINE.is_match(t) {
                    continue;
                }
                let masked = MASK.replace_all(line, |c: &regex::Captures| "\0".repeat(c[0].chars().count()));
                let raw: Vec<char> = line.chars().collect();
                let low = lower(&masked);
                let mut j = 0;
                while j < low.len() {
                    let hit = names.iter().find(|n| {
                        low[j..].starts_with(n)
                            && (j == 0 || !low[j - 1].is_alphanumeric())
                            && self.resolve(&raw[j..j + n.len()].iter().collect::<String>(), o.bundle()) == Some(target)
                            && !all.iter().any(|a| a.len() > n.len() && a.starts_with(n) && low[j..].starts_with(a))
                    });
                    match hit {
                        Some(n) => {
                            count += 1;
                            if first.is_none() {
                                first = Some((i + 1, raw[j..j + n.len()].iter().collect(), cut(line.trim(), 200)));
                            }
                            j += n.len();
                        }
                        None => j += 1,
                    }
                }
            }
            if let Some((line, word, text)) = first {
                out.push(json!({ "path": o.path, "title": o.title, "line": line, "word": word, "text": text, "count": count, "link": format!("[[{word}]]") }));
            }
        }
        out
    }

    /// 저장하려는 문서의 제목 · 별칭 · 파일 이름이 같은 묶음 다른 문서의 제목 · 별칭 · 파일 이름과 겹치는지.
    /// 겹치면 [[이름]] 이 경고 없이 한쪽으로만 가고(name_maps), 같은 개념이 두 장으로 갈라진다.
    /// 다른 묶음과는 견주지 않는다 — 분야마다 같은 이름의 다른 용어(산사태 · 하천의 「대피소」)를 두는 것이 설계다.
    /// 묶음이 없는 옛 꼴 문서만은 모든 묶음과 견준다.
    /// 이미 있는 문서는 이번에 새로 단 이름만 본다 — 옛날부터 겹쳐 있던 문서도 고칠 수는 있게.
    /// 2026.11.09 : 검색해 보라는 지침만으로는 같은 개념을 새로 만드는 것을 막지 못해 저장에서 막는다.
    pub fn name_clash(&self, path: &str, title: &str, aliases: &[String]) -> Option<String> {
        let names_of = |pg: &Page| -> Vec<String> {
            let mut v = vec![pg.title.clone(), pg.path.rsplit('/').next().unwrap().to_string()];
            v.extend(pg.aliases.iter().cloned());
            v.into_iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect()
        };
        let had: Vec<String> = self.get(path).map(&names_of).unwrap_or_default();
        let mut mine = vec![title.to_string(), path.rsplit('/').next().unwrap_or(path).to_string()];
        mine.extend(aliases.iter().cloned());
        // 묶음이 없는 옛 꼴 문서(개념/유출구 · 대문)는 어느 묶음에서나 「하나뿐인 이름」으로 찾히므로 모든 묶음과 견준다.
        // 그러지 않으면 새 꼴 문서가 옛 문서와 같은 이름을 달아 그 이름이 둘이 되고, 다른 묶음의 [[이름]] 이 끊긴다(resolve 4번).
        let group = |p: &str| -> String {
            let b = bundle_of(p);
            if b.is_empty() || KINDS.contains(&b) { String::new() } else { b.to_string() }
        };
        let mine_g = group(path);
        let near = |o: &Page| -> bool {
            let g = group(&o.path);
            g == mine_g || g.is_empty()
        };
        for n in mine.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty() && !had.contains(n)) {
            if let Some(o) = self.all().find(|o| o.path != path && near(o) && names_of(o).contains(&n)) {
                let what = if o.title.to_lowercase() == n { "제목" } else if o.aliases.iter().any(|a| a.trim().to_lowercase() == n) { "별칭" } else { "이름" };
                return Some(format!(
                    "「{n}」은 이미 「{}」 문서의 {what}입니다. 새로 만들지 말고 그 문서를 고쳐 합치고, 같은 뜻의 다른 이름은 그 문서 aliases 에 더하세요. 뜻이 다른 말이면 이름을 달리 지으세요",
                    o.path
                ));
            }
        }
        None
    }

    /// 그 이름(제목 · 별칭 · 이름 · 묶음 안 경로)을 가진 문서를 모든 묶음에서.
    pub fn candidates(&self, name: &str) -> Vec<&str> {
        let n = name.trim().to_lowercase();
        let mut out: Vec<&str> = self.by_name.values().filter_map(|m| m.get(&n)).map(String::as_str).collect();
        out.sort();
        out
    }

    /// 있는 묶음과 문서 수 : 묶음 목록에 올린 묶음(문서가 없어도) + 문서 경로에 나오는 묶음. 공유 묶음은 맨 뒤, 나머지는 사전 순서.
    pub fn bundles(&self) -> Vec<(String, usize)> {
        let mut m: BTreeMap<&str, usize> = BTreeMap::new();
        for b in &self.registry.bundles {
            m.entry(b.name.as_str()).or_default();
        }
        for p in self.pages.keys() {
            let b = bundle_of(p);
            if !b.is_empty() {
                *m.entry(b).or_default() += 1;
            }
        }
        let mut out: Vec<(String, usize)> = m.into_iter().map(|(b, n)| (b.to_string(), n)).collect();
        out.sort_by_cached_key(|(b, _)| (self.is_shared(b), ko_key(b)));
        out
    }

    pub fn has_bundle(&self, b: &str) -> bool {
        !b.is_empty() && (self.registry.bundle(b).is_some() || self.pages.keys().any(|p| bundle_of(p) == b))
    }

    pub fn backlinks(&self, p: &str) -> Vec<Brief> {
        if !self.pages.contains_key(p) {
            return vec![];
        }
        self.all().filter(|o| o.path != p && o.links.iter().any(|l| self.resolve(l, o.bundle()) == Some(p))).map(Page::brief).collect()
    }

    /// 본문의 [[링크]] 이름 → 가리키는 문서(없으면 null). 화면이 없는 문서 링크를 빨갛게 그린다. from 은 그 본문의 묶음.
    pub fn link_map<'a>(&self, names: impl IntoIterator<Item = &'a str>, from: &str) -> serde_json::Map<String, Value> {
        let mut out = serde_json::Map::new();
        for n in names {
            let v = self.resolve(n, from).and_then(|p| self.get(p)).map(|pg| json!({ "path": pg.path, "title": pg.title, "kind": pg.kind })).unwrap_or(Value::Null);
            out.insert(n.to_string(), v);
        }
        out
    }

    /// 매뉴얼 차례 : <묶음>/매뉴얼/<권>/<문서>. 권 순서는 목록에 적은 order, 없으면 그 안 문서 order 의 가장 작은 값.
    /// 목록에 올린 권은 문서가 없어도 빈 권으로 낸다 — 화면에서 만든 권에 첫 문서를 쓸 자리가 보여야 한다.
    pub fn manual_tree(&self, bundle: &str) -> Vec<Value> {
        let mut groups: Vec<(String, Vec<&Page>)> = self.registry.volumes.iter().filter(|v| v.bundle == bundle).map(|v| (v.name.clone(), vec![])).collect();
        for pg in self.all().filter(|x| x.kind == "manual" && x.bundle() == bundle) {
            let g = pg.volume().to_string();
            match groups.iter_mut().find(|(n, _)| *n == g) {
                Some((_, v)) => v.push(pg),
                None => groups.push((g, vec![pg])),
            }
        }
        for (_, items) in groups.iter_mut() {
            items.sort_by(|a, b| a.order_f().total_cmp(&b.order_f()).then_with(|| ko_key(&a.title).cmp(&ko_key(&b.title))));
        }
        let min = |name: &str, v: &Vec<&Page>| {
            self.registry.volume(bundle, name).and_then(|x| x.order).unwrap_or_else(|| v.iter().map(|p| p.order_f()).fold(f64::INFINITY, f64::min))
        };
        groups.sort_by(|(an, av), (bn, bv)| match (an.is_empty(), bn.is_empty()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => min(an, av).total_cmp(&min(bn, bv)).then_with(|| ko_key(an).cmp(&ko_key(bn))),
        });
        groups
            .into_iter()
            .map(|(name, items)| {
                let order = min(&name, &items);
                let order = if !order.is_finite() { Value::Null } else if order.fract() == 0.0 { json!(order as i64) } else { json!(order) };
                let about = self.registry.volume(bundle, &name).map(|v| v.about.clone()).unwrap_or_default();
                json!({ "name": name, "bundle": bundle, "about": about, "items": items.iter().map(|p| p.brief()).collect::<Vec<_>>(), "order": order })
            })
            .collect()
    }
}

/// 이름 찾기 표 두 벌 : 전체 경로 → 경로, 묶음 → (이름 → 경로).
/// 별칭보다 제목이 먼저다. 같은 말이 어느 문서의 제목이고 다른 문서의 별칭이면 제목 쪽으로 간다(뒤에 넣은 것이 이긴다).
fn name_maps(pages: &BTreeMap<String, Page>) -> (HashMap<String, String>, HashMap<String, HashMap<String, String>>) {
    let by_path = pages.keys().map(|p| (p.to_lowercase(), p.clone())).collect();
    let mut by_name: HashMap<String, HashMap<String, String>> = HashMap::new();
    let keys: [&dyn Fn(&Page) -> Vec<String>; 4] = [
        &|pg| pg.aliases.clone(),
        &|pg| vec![pg.path.rsplit('/').next().unwrap().to_string()],
        &|pg| vec![pg.title.clone()],
        &|pg| vec![in_bundle(&pg.path).to_string()],
    ];
    for key in keys {
        for pg in pages.values() {
            let m = by_name.entry(pg.bundle().to_lowercase()).or_default();
            for k in key(pg) {
                m.insert(k.to_lowercase(), pg.path.clone());
            }
        }
    }
    (by_path, by_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 요약은_첫_문단_목록이면_첫_항목() {
        let pg = to_page("산사태/개념/계류", "---\ntitle: 계류\n---\n\n# 계류\n\n![그림](/a.png)\n\n- 산골짜기를 흐르는 [[작은 물길|물길]]이다.\n- 둘째 항목\n");
        assert_eq!(pg.summary, "산골짜기를 흐르는 물길이다.");
        assert_eq!(pg.links, vec!["작은 물길"]);
        assert_eq!(pg.image.as_deref(), Some("/a.png"));
        assert_eq!(pg.kind, "concept");
        assert_eq!(pg.order, json!(1000));
    }

    #[test]
    fn 요약_그림은_코드_예시와_html_도식을_건너뛴다() {
        let body = "## 쓰는 법\n\n| 표기 | 예 |\n|---|---|\n| 도식 | `![설명](/assets/a.html \"480\")` |\n\n~~~\n![예](/assets/b.png) [[예시]]\n~~~\n\n![움직이는 도식](/assets/c.html#x \"720\")\n*도식*\n\n![그림](/assets/d.jpg)\n*그림*\n";
        let pg = to_page("공통/매뉴얼/위키 사용법/쓰는 법", body);
        assert_eq!(pg.image.as_deref(), Some("/assets/d.jpg"));
        assert!(pg.links.is_empty());
        assert_eq!(to_page("공통/개념/가", "![도식](/assets/c.html)\n").image, None);
    }

    #[test]
    fn 제목_앵커는_화면과_같다() {
        // web 에서 github-slugger 로 뽑은 값 (2026.11.09)
        let mut s = Slugger::new();
        let got: Vec<String> =
            ["1. 개요 (요약)", "A · B", "토석류/산사태", "정의—뜻", "Hello_World", "여름 장마철", "여름 장마철", "KLES 모델?", "「유출구」란", "C++ & Rust", "  공백  둘  ", "emoji 🌧 비"].iter().map(|h| s.slug(h)).collect();
        assert_eq!(got, ["1-개요-요약", "a--b", "토석류산사태", "정의뜻", "hello_world", "여름-장마철", "여름-장마철-1", "kles-모델", "유출구란", "c--rust", "--공백--둘--", "emoji--비"]);
    }

    #[test]
    fn 단락은_두세_단계_제목으로_나눈다() {
        let body = "머리 글이다.\n\n# 큰 제목\n\n## 정의\n\n**계류**는 [[물길|작은 물길]]이다.\n\n### 생김새\n\n좁다.\n\n```\n## 코드 안 제목\n```\n\n## 정의\n\n두 번째 정의.\n\n## 빈 절\n";
        let s = sections(body);
        let v: Vec<(&str, &str, &str)> = s.iter().map(|x| (x.heading.as_str(), x.anchor.as_str(), x.text.as_str())).collect();
        assert_eq!(
            v,
            vec![
                ("", "", "머리 글이다. 큰 제목"),
                ("정의", "정의", "계류는 작은 물길이다."),
                ("정의 › 생김새", "생김새", "좁다. ## 코드 안 제목"), // 코드 안 제목은 단락을 나누지 않는다
                ("정의", "정의-1", "두 번째 정의."),
            ]
        );
    }

    #[test]
    fn 긴_단락은_문단에서_나눈다() {
        let para = "가".repeat(700);
        let s = sections(&format!("## 길다\n\n{para}\n\n{para}\n\n짧다"));
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|x| x.anchor == "길다" && x.text.chars().count() <= SECTION_MAX));
    }

    #[test]
    fn 한국어_사전_순서() {
        // node -e "console.log([...].sort((a,b)=>a.localeCompare(b,'ko')))" 의 결과 (한자는 ko_key 주석대로 빼고 견준다)
        let mut v = vec!["KLES", "계류", "1차", "abc", "Zeta", "가나", "탱크모델", "탱크 모델"];
        v.sort_by_cached_key(|s| ko_key(s));
        assert_eq!(v, vec!["1차", "가나", "계류", "탱크 모델", "탱크모델", "abc", "KLES", "Zeta"]);
    }

    #[test]
    fn 표는_항목_값_글로_편다() {
        let md = "앞 글\n\n| 규칙 | 보는 것 |\n|---|:--:|\n| section | [[개념]] 절이 있는지 |\n| a \\| b | 비어도 |\n\n| 표 아닌 줄\n";
        assert_eq!(plain(md), "앞 글 규칙: section · 보는 것: 개념 절이 있는지 규칙: a | b · 보는 것: 비어도 | 표 아닌 줄");
    }

    #[test]
    fn 끼워_넣기와_목차_표시는_글에서_정리한다() {
        let pg = to_page("공통/매뉴얼/위키 사용법/쓰기", "[목차]\n\n## 주의\n\n![[틀/주의|조심]]\n\n![[계류#정의]]\n");
        assert_eq!(pg.links, vec!["틀/주의", "계류"]); // 끼운 문서도 역링크 · 그래프에 잡힌다
        assert_eq!(pg.volume(), "위키 사용법");
        assert_eq!(pg.bundle(), "공통");
        assert_eq!(pg.sections.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), vec!["조심 계류"]);
    }

    #[test]
    fn 종류는_묶음_다음_폴더다() {
        let m = Meta::new();
        assert_eq!(kind_of("산사태/개념/계류", &m), "concept");
        assert_eq!(kind_of("공통/매뉴얼/위키 사용법/쓰기", &m), "manual");
        assert_eq!(kind_of("산사태/대문", &m), "page");
        assert_eq!(kind_of("산사태/개념", &m), "page"); // 「개념」이라는 이름의 일반 문서
        assert!(is_template("공통/틀/주의") && !is_template("틀/주의"));
        assert!(check_new_path("산사태/개념/계류").is_ok());
        assert!(check_new_path("개념/계류").is_err() && check_new_path("대문").is_err());
    }

    #[test]
    fn 링크는_지금_묶음_공유_묶음_하나뿐인_다른_묶음_순서로_찾는다() {
        let list = [
            ("산사태/개념/대피소", "산림 대피소다."),
            ("하천/개념/대피소", "홍수 대피소다."),
            ("공통/개념/행정경계", "시군구 경계다."),
            ("산사태/개념/유출구", "---\naliases: [유출 지점]\n---\n나가는 점이다."),
            ("공통/틀/주의", "조심."),
        ];
        let pages: BTreeMap<String, Page> = list.iter().map(|(p, t)| (p.to_string(), to_page(p, t))).collect();
        let (by_path, by_name) = name_maps(&pages);
        let index = search::Index::build(pages.values()).unwrap();
        let chunk_index = search::ChunkIndex::build(&[]).unwrap();
        let registry = crate::bundles::seed(&["공통".into()]);
        let shared = registry.shared();
        let w = Wiki { pages, by_path, by_name, index, chunks: vec![], chunk_index, registry, shared };
        assert_eq!(w.resolve("대피소", "산사태"), Some("산사태/개념/대피소"));
        assert_eq!(w.resolve("대피소", "하천"), Some("하천/개념/대피소"));
        assert_eq!(w.resolve("대피소", "공통"), None); // 두 묶음에 있으면 고르지 않는다
        assert_eq!(w.resolve("하천/대피소", "산사태"), Some("하천/개념/대피소"));
        assert_eq!(w.resolve("하천/개념/대피소", "산사태"), Some("하천/개념/대피소"));
        assert_eq!(w.resolve("행정경계", "산사태"), Some("공통/개념/행정경계"));
        assert_eq!(w.resolve("유출 지점", "하천"), Some("산사태/개념/유출구")); // 하나뿐이면 다른 묶음에서도 찾는다
        assert_eq!(w.resolve("틀/주의", "산사태"), Some("공통/틀/주의"));
        assert_eq!(w.resolve("개념/대피소", "하천"), Some("하천/개념/대피소"));
        assert_eq!(w.candidates("대피소"), vec!["산사태/개념/대피소", "하천/개념/대피소"]);
        assert_eq!(w.bundles().iter().map(|(b, _)| b.as_str()).collect::<Vec<_>>(), vec!["산사태", "하천", "공통"]);
        assert!(w.in_scope("공통/개념/행정경계", "산사태") && !w.in_scope("하천/개념/대피소", "산사태"));
        // 공유 묶음이 없으면 지금 묶음 → 하나뿐인 다른 묶음 순서만 남는다(「공통」 이름에 기대지 않는다).
        let mut w = w;
        w.shared.clear();
        assert!(!w.in_scope("공통/개념/행정경계", "산사태"));
        assert_eq!(w.resolve("틀/주의", "산사태"), Some("공통/틀/주의")); // 하나뿐이라 찾는다
        let w = w;
        // 이름 겹침 : 같은 묶음의 제목 · 별칭 · 파일 이름과 겹치면 막고, 다른 묶음 · 자기 옛 이름은 두고 본다.
        let none: Vec<String> = vec![];
        assert!(w.name_clash("산사태/개념/유출 지점", "유출 지점", &none).unwrap().contains("별칭"));
        assert!(w.name_clash("산사태/개념/출구", "출구", &["대피소".into()]).unwrap().contains("산사태/개념/대피소"));
        assert!(w.name_clash("산사태/개념/출구", "Unique", &["유출구".into()]).is_some());
        assert_eq!(w.name_clash("하천/개념/유출구", "유출구", &none), None);
        assert_eq!(w.name_clash("산사태/개념/유출구", "유출구", &["유출 지점".into(), "나가는 곳".into()]), None);
        // 링크 안 된 언급
        let list = [
            ("산사태/개념/계류", "---\naliases: [溪流]\n---\n물길이다."),
            ("산사태/개념/계류보전", "물길을 지킨다."),
            ("산사태/개념/사방댐", "계류에 둔다. 溪流 에도. [[계류]] 는 아니다."),
            ("산사태/개념/임도", "계류보전 사업과 `계류` 와 「계류」 와 산계류 는 아니고\n\n# 계류\n\n둘째 줄 계류에서 본다."),
            ("하천/개념/물길", "계류 는 하천에서 다른 말이 아니다."),
        ];
        let pages: BTreeMap<String, Page> = list.iter().map(|(p, t)| (p.to_string(), to_page(p, t))).collect();
        let (by_path, by_name) = name_maps(&pages);
        let index = search::Index::build(pages.values()).unwrap();
        let chunk_index = search::ChunkIndex::build(&[]).unwrap();
        let m = Wiki { pages, by_path, by_name, index, chunks: vec![], chunk_index, registry: Default::default(), shared: vec![] };
        let got = m.mentions("산사태/개념/계류");
        let brief: Vec<(String, u64, u64)> = got.iter().map(|v| (v["path"].as_str().unwrap().to_string(), v["line"].as_u64().unwrap(), v["count"].as_u64().unwrap())).collect();
        // 사방댐은 이미 이었으니 빼고, 임도는 계류보전 · 코드 · 낫표 · 산계류 · 제목 줄을 건너 5째 줄만, 하천은 하나뿐인 이름이라 센다.
        assert_eq!(brief, vec![("산사태/개념/임도".to_string(), 5, 1), ("하천/개념/물길".to_string(), 1, 1)]);
        // 옛 꼴(묶음 없는) 문서는 어느 묶음에서 새로 써도 견준다.
        let mut pages = BTreeMap::new();
        pages.insert("개념/KLES".to_string(), to_page("개념/KLES", "---\naliases: [KLES 모델]\n---\n모델이다."));
        let (by_path, by_name) = name_maps(&pages);
        let index = search::Index::build(pages.values()).unwrap();
        let chunk_index = search::ChunkIndex::build(&[]).unwrap();
        let old = Wiki { pages, by_path, by_name, index, chunks: vec![], chunk_index, registry: Default::default(), shared: vec![] };
        assert!(old.name_clash("산사태/개념/탱크 모델", "탱크 모델", &["kles 모델".into()]).unwrap().contains("개념/KLES"));
        assert!(old.name_clash("하천/개념/KLES", "KLES", &none).is_some());
    }

    #[test]
    fn 코드_안의_링크는_세지_않는다() {
        let pg = to_page("대문", "본문 [[가]] 와 `[[나]]` 와\n```\n[[다]]\n```\n");
        assert_eq!(pg.links, vec!["가"]);
    }
}
