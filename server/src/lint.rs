// 글 린트 : 위키 「글쓰기 표준」 가운데 기계로 가릴 수 있는 것만 본다.
// 뜻을 알아야 하는 것(정의가 뜻을 세우는가 · 문장이 매끄러운가)은 보지 않는다. 그것은 표준 문서를 읽은 AI 가 맡는다.
//
// 2026.11.09 : 경고만 내고 저장은 막지 않는다. 오탐을 지켜본 뒤 확실한 규칙만 거절로 올린다.
// 2026.11.09 : 「개념 문서에 그림 한 장 이상」 규칙을 뺐다. 사진 · 도식 · 표 가운데 무엇이 맞는지는 내용이 정하므로 기계로 가릴 수 없다.
// 규칙 이름(rule)은 표준 문서 「린트가 보는 것」 표와 같게 둔다. 하나를 바꾸면 다른 쪽도 고친다.
//
//   lint()        문서 하나 → 경고 목록
//   prose()       코드 · 주소 · 「인용」을 벗긴 줄 (어투 · 상투어 · 식별자 검사용)
//   tone() · cliche() · ascii_ids() · structure() · vocab()   규칙 갈래
//   terms()       「용어 표준」 문서의 표 → (쓰지 않는 말, 표준어)
use crate::frontmatter::Meta;
use crate::pages::{Wiki, kind_of};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Serialize, Debug, PartialEq)]
pub struct Warning {
    pub rule: &'static str,
    pub line: usize, // 본문(머리말 뺀) 줄 번호 · 문서 전체에 걸린 것은 0
    pub message: String,
}

/// 표준의 정본인 위키 문서. MCP style_guide 가 이 문서를 그대로 읽어 준다.
pub const GUIDE_WRITING: &str = "공통/매뉴얼/위키 사용법/글쓰기 표준";
pub const GUIDE_IMAGE: &str = "공통/매뉴얼/위키 사용법/그림 표준";
pub const GUIDE_TERMS: &str = "공통/매뉴얼/위키 사용법/용어 표준";

const MAX: usize = 30; // 경고가 이보다 많으면 문서를 표준대로 다시 쓰는 편이 낫다

static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`]*`").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+|\]\([^)]*\)").unwrap());
// 낫표 안은 화면 이름이거나 남의 말을 옮긴 것이라 어투 · 상투어를 보지 않는다.
static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"「[^」]*」").unwrap());
static WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[[^\]]*\]\]").unwrap());
static ASCII_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9_][A-Za-z0-9_.\-]*").unwrap());
static FILE_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(java|jsp|js|mjs|ts|tsx|xml|sql|rs|py|css|html|properties)$").unwrap());
static ISSUE_NO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{2,}-\d+$").unwrap());
// 문장 끝 「…다」 와 그 앞 두 글자. 합쇼체는 「ㅂ니다」(합니다 · 습니다)라 「아니다」 와 가른다.
static END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([가-힣]?)([가-힣])다(\.|\?|$)").unwrap());
static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*!\[[^\]]*\]\(").unwrap());
static CAPTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\*[^*].*\*$").unwrap());

/// AI 가 즐겨 쓰지만 아무 말도 더하지 않는 표현. 표준 문서 「쓰지 않는 표현」과 같게 둔다.
const CLICHES: [&str; 12] = [
    "중요한 역할", "다양한", "라고 할 수 있", "살펴보", "알아보", "결론적으로",
    "요약하면", "정리하면", "주목할", "필수적인", "되어지", "되어진",
];

fn warn(rule: &'static str, line: usize, message: impl Into<String>) -> Warning {
    Warning { rule, line, message: message.into() }
}

/// 본문 줄 가운데 산문만 (번호, 벗긴 글). 코드 블록 · 제목 · 그림 · 그림 설명 줄은 뺀다.
fn prose(body: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut fence = false;
    for (i, raw) in body.lines().enumerate() {
        let t = raw.trim();
        if t.starts_with("```") {
            fence = !fence;
            continue;
        }
        if fence || t.starts_with('#') || IMAGE.is_match(t) || CAPTION.is_match(t) {
            continue;
        }
        let s = INLINE_CODE.replace_all(t, " ");
        let s = URL.replace_all(&s, " ");
        out.push((i + 1, s.into_owned()));
    }
    out
}

/// 받침이 ㅂ 인 한글 음절인가 (합 · 습 · 됩 · 갑 …).
fn ends_with_b(c: Option<char>) -> bool {
    c.is_some_and(|c| ('가'..='힣').contains(&c) && (c as u32 - 0xAC00) % 28 == 17)
}

fn tone(kind: &str, lines: &[(usize, String)], out: &mut Vec<Warning>) {
    for (n, l) in lines {
        let l = QUOTE.replace_all(l, " ");
        let formal: Vec<bool> = END.captures_iter(&l).map(|c| &c[2] == "니" && ends_with_b(c[1].chars().next())).collect();
        match kind {
            "concept" if formal.iter().any(|f| *f) => out.push(warn("tone", *n, "개념 문서는 한다체로 쓴다 (~이다 · ~한다)")),
            "manual" if formal.iter().any(|f| !*f) => out.push(warn("tone", *n, "매뉴얼은 합쇼체로 쓴다 (~합니다 · ~누릅니다)")),
            _ => {}
        }
    }
}

fn cliche(lines: &[(usize, String)], out: &mut Vec<Warning>) {
    for (n, l) in lines {
        let l = QUOTE.replace_all(l, " ");
        for c in CLICHES.iter().filter(|c| l.contains(**c)) {
            out.push(warn("cliche", *n, format!("「{c}」 은 쓰지 않는다. 무엇을 하는지 직접 쓴다")));
        }
    }
}

fn symbols(lines: &[(usize, String)], out: &mut Vec<Warning>) {
    for (n, l) in lines {
        if l.contains('—') || l.contains('–') {
            out.push(warn("dash", *n, "줄표 대신 가운뎃점 · 을 쓰거나 문장을 나눈다"));
        }
        // 그림 문자 영역(☀ ✅ 🔥 …). 가운뎃점 · 낫표는 이 영역 밖이다.
        if l.chars().any(|c| matches!(c as u32, 0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0x2B50)) {
            out.push(warn("emoji", *n, "이모지 · 장식 기호를 쓰지 않는다"));
        }
    }
}

/// 소스 파일 이름 · 테이블 · 컬럼 · 코드값 · 내부 번호. 위키는 코드베이스를 모르는 사람도 읽는다.
fn ascii_ids(lines: &[(usize, String)], out: &mut Vec<Warning>) {
    for (n, l) in lines {
        for m in ASCII_WORD.find_iter(l) {
            let w = m.as_str().trim_end_matches(['.', '-']);
            let upper_snake = w.contains('_') && w.chars().any(|c| c.is_ascii_uppercase()) && !w.chars().any(|c| c.is_ascii_lowercase());
            let lower_snake = w.contains('_') && w.split('_').filter(|s| !s.is_empty()).count() >= 2 && w.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit());
            if upper_snake || lower_snake || FILE_EXT.is_match(w) {
                out.push(warn("code-id", *n, format!("「{w}」 같은 코드 이름 대신 업무 · 지형 · 법의 말로 쓴다")));
            } else if ISSUE_NO.is_match(w) {
                out.push(warn("internal-no", *n, format!("「{w}」 같은 내부 번호를 쓰지 않는다")));
            }
        }
    }
}

fn structure(kind: &str, body: &str, out: &mut Vec<Warning>) {
    let lines: Vec<&str> = body.lines().collect();
    let has = |h: &str| lines.iter().any(|l| l.trim() == h);
    let mut fence = false;
    let mut first_section = None;
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.starts_with("```") {
            fence = !fence;
        }
        if fence {
            continue;
        }
        if t.starts_with("# ") {
            out.push(warn("h1", i + 1, "# 제목은 쓰지 않는다. 제목은 머리말 title 이 맡고, 절은 ## 부터"));
        }
        if t.starts_with("## ") && first_section.is_none() {
            first_section = Some(i);
        }
        // 화면은 그림 바로 아래 *기울임* 줄을 그림 설명으로 그린다. 없으면 출처를 알 수 없다.
        if IMAGE.is_match(t) && !lines.get(i + 1).is_some_and(|n| CAPTION.is_match(n.trim())) {
            out.push(warn("caption", i + 1, "그림 바로 아래 줄에 *그림 설명 · 출처* 를 둔다"));
        }
    }
    match kind {
        "concept" => {
            for h in ["## 정의", "## 관련"] {
                if !has(h) {
                    out.push(warn("section", 0, format!("개념 문서에는 「{h}」 절이 있어야 한다")));
                }
            }
            // 정의 첫 항목은 다른 문서의 요약 카드에 그대로 뜬다. 두 문장이 넘으면 카드가 길어져 뜻이 흐려진다.
            let def = lines.iter().position(|l| l.trim() == "## 정의");
            let first = def.and_then(|d| (d + 1..lines.len()).take_while(|&i| !lines[i].trim().starts_with("## ")).find(|&i| !lines[i].trim().is_empty()));
            if let Some(i) = first {
                let t = QUOTE.replace_all(lines[i], " ");
                if END.find_iter(&t).count() > 1 {
                    out.push(warn("definition", i + 1, "정의 첫 항목은 한 문장으로 쓴다. 덧붙일 말은 다음 항목으로 내린다"));
                }
            }
        }
        "manual" => {
            let head = &lines[..first_section.unwrap_or(lines.len())];
            if let Some(i) = head.iter().position(|l| {
                let t = l.trim();
                // [목차] · ![[틀/…]] 끼워 넣기는 리드 문단이 아니다 — 첫 절 앞에 두는 것이 보통이다.
                !t.is_empty() && !IMAGE.is_match(t) && !CAPTION.is_match(t) && t != "[목차]" && !(t.starts_with("![[") && t.ends_with("]]"))
            }) {
                out.push(warn("lead", i + 1, "매뉴얼은 리드 문단 없이 첫 ## 절부터 쓴다"));
            }
        }
        _ => {}
    }
}

/// 「용어 표준」 문서의 표에서 (쓰지 않는 말, 표준어) 를 읽는다. 절마다 표가 하나씩 있다.
/// 첫 칸에 여러 말을 · 로 함께 적을 수 있다. 표마다 머리 줄 · 구분 줄은 건너뛴다.
/// 2026.11.09 : 처음에는 개념 문서 별칭을 비표준어로 보았으나, 별칭은 찾기용 다른 이름(유역 · 사방사업)이라 오탐이 많아 표로 옮겼다.
/// 2026.11.09 : 표를 「글쓰기 표준」에서 떼어 냈다. 과업마다 용어가 달라 한 표준 문서에 섞으면 서로 부딪힌다.
fn terms(wiki: &Wiki) -> Vec<(String, String)> {
    let Some(g) = wiki.get(GUIDE_TERMS) else { return vec![] };
    let clean = |s: &str| s.trim().trim_matches(['「', '」', '`']).trim().to_string();
    let mut out = Vec::new();
    let mut header = true;
    for l in g.body.lines().map(str::trim) {
        if !l.starts_with('|') {
            header = true; // 표 밖으로 나오면 다음 표의 머리 줄을 다시 건너뛴다
            continue;
        }
        let cells: Vec<&str> = l.trim_matches('|').split('|').collect();
        if header || cells.iter().all(|c| c.trim().chars().all(|ch| ch == '-' || ch == ':')) {
            header = false;
            continue;
        }
        if cells.len() < 2 {
            continue;
        }
        let std = clean(cells[1]);
        for w in cells[0].split('·').map(clean).filter(|w| !w.is_empty() && *w != std) {
            out.push((w, std.clone()));
        }
    }
    out
}

fn vocab(wiki: &Wiki, path: &str, lines: &[(usize, String)], out: &mut Vec<Warning>) {
    if path == GUIDE_TERMS || path == GUIDE_WRITING {
        return; // 쓰지 않는 말을 예로 드는 문서다
    }
    for (w, std) in terms(wiki) {
        // 링크 글자 · 낫표 인용은 일부러 쓴 말이다.
        let hit = lines.iter().find(|(_, l)| QUOTE.replace_all(&WIKILINK.replace_all(l, " "), " ").contains(w.as_str()));
        if let Some((n, _)) = hit {
            out.push(warn("term", *n, format!("「{w}」 → 「{std}」 (용어 표준)")));
        }
    }
}

/// 문서 하나를 본다. body 는 머리말을 뺀 본문이다.
pub fn lint(wiki: &Wiki, path: &str, body: &str) -> Vec<Warning> {
    let kind = kind_of(path, &Meta::new());
    let lines = prose(body);
    let mut out = Vec::new();
    structure(kind, body, &mut out);
    tone(kind, &lines, &mut out);
    symbols(&lines, &mut out);
    cliche(&lines, &mut out);
    ascii_ids(&lines, &mut out);
    vocab(wiki, path, &lines, &mut out);
    out.sort_by_key(|w| w.line);
    out.truncate(MAX);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(kind_path: &str, body: &str) -> Vec<&'static str> {
        let lines = prose(body);
        let kind = kind_of(kind_path, &Meta::new());
        let mut out = Vec::new();
        structure(kind, body, &mut out);
        tone(kind, &lines, &mut out);
        symbols(&lines, &mut out);
        cliche(&lines, &mut out);
        ascii_ids(&lines, &mut out);
        out.into_iter().map(|w| w.rule).collect()
    }

    const GOOD_CONCEPT: &str = "![계류](/assets/a.jpg)\n*AI 생성 그림 · 파란 화살표가 물 흐름*\n\n## 정의\n\n- 산골짜기를 흐르는 물길이다.\n\n## 관련\n\n- [[유출구]]\n";

    #[test]
    fn 표준대로_쓴_개념_문서는_경고가_없다() {
        assert!(rules("산사태/개념/계류", GOOD_CONCEPT).is_empty());
    }

    #[test]
    fn 개념_문서의_빠진_절과_그림을_잡는다() {
        let r = rules("산사태/개념/계류", "## 정의\n\n- 물길이다.\n");
        assert_eq!(r, vec!["section"]);
    }

    #[test]
    fn 정의_첫_항목이_두_문장이면_잡는다() {
        assert_eq!(rules("산사태/개념/계류", &GOOD_CONCEPT.replace("물길이다.", "물길이다. 평소에는 말라 있다.")), vec!["definition"]);
        // 둘째 항목은 길어도 된다
        assert!(rules("산사태/개념/계류", &GOOD_CONCEPT.replace("물길이다.\n", "물길이다.\n- 평소에는 말라 있다. 비가 오면 흐른다.\n")).is_empty());
    }

    #[test]
    fn 종류마다_어투를_본다() {
        assert_eq!(rules("산사태/개념/계류", &GOOD_CONCEPT.replace("물길이다.", "물길입니다.")), vec!["tone"]);
        assert_eq!(rules("공통/매뉴얼/a/b", "## 하기\n\n1. 「저장」을 누른다.\n"), vec!["tone"]);
        assert!(rules("공통/매뉴얼/a/b", "## 하기\n\n1. 「저장」을 누릅니다.\n").is_empty());
        assert!(rules("산사태/개념/계류", &GOOD_CONCEPT.replace("물길이다.", "호수가 아니다.")).is_empty());
        assert_eq!(rules("공통/매뉴얼/a/b", "## 하기\n\n1. 지우는 곳이 아니다.\n"), vec!["tone"]);
    }

    #[test]
    fn 낫표_안과_코드는_보지_않는다() {
        assert!(rules("공통/매뉴얼/a/b", "## 예\n\n- 「사방댐 문서에 한 문단 더해 줘」 라고 부탁합니다.\n- `TB_FDR_RCPT` 처럼 씁니다.\n\n```\nmcp_add 다양한 —\n```\n").is_empty());
    }

    #[test]
    fn 기호_상투어_코드_이름을_잡는다() {
        let r = rules("일반", "사방댐은 중요한 역할을 한다 — TB_FDR_RCPT 와 fdrController.java 를 본다. FDR-106 참고 🔥\n");
        assert_eq!(r, vec!["dash", "emoji", "cliche", "code-id", "code-id", "internal-no"]);
    }

    #[test]
    fn 매뉴얼_리드_문단과_그림_설명을_잡는다() {
        let r = rules("공통/매뉴얼/a/b", "이 문서는 저장을 설명합니다.\n\n## 하기\n\n![화면](/assets/x.png)\n\n1. 누릅니다.\n");
        assert_eq!(r, vec!["caption", "lead"]);
        assert!(rules("공통/매뉴얼/a/b", "[목차]\n\n![[틀/주의]]\n\n## 하기\n\n1. 누릅니다.\n").is_empty());
    }
}
