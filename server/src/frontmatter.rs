// 문서 머리말 : 사람이 손으로 고쳐도 깨지지 않게 YAML 의 아주 작은 부분만 쓴다.
//   key: 값          문자열 · 숫자
//   key: [가, 나]    목록
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

pub type Meta = Map<String, Value>;

static FM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n---\r?\n?").unwrap());
static KV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$").unwrap());
static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?\d+(\.\d+)?$").unwrap());

pub fn parse(text: &str) -> (Meta, String) {
    let Some(m) = FM.captures(text) else { return (Meta::new(), text.to_string()) };
    let mut meta = Meta::new();
    for line in m[1].split('\n').map(|l| l.trim_end_matches('\r')) {
        let Some(kv) = KV.captures(line) else { continue };
        let v = kv[2].trim();
        let value = if v.starts_with('[') && v.ends_with(']') && v.len() >= 2 {
            Value::Array(v[1..v.len() - 1].split(',').map(|s| unquote(s.trim())).filter(|s| !s.is_empty()).map(Value::String).collect())
        } else {
            let s = unquote(v);
            if NUM.is_match(&s) { number(&s) } else { Value::String(s) }
        };
        meta.insert(kv[1].to_string(), value);
    }
    (meta, text[m.get(0).unwrap().end()..].to_string())
}

fn number(s: &str) -> Value {
    if let Ok(i) = s.parse::<i64>() {
        return Value::from(i);
    }
    s.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or_else(|| Value::String(s.into()))
}

fn unquote(s: &str) -> String {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

/// 값을 머리말 한 줄에 쓰는 꼴. 숫자는 1.0 이 아니라 1 로 쓴다(사람이 쓴 꼴과 같게).
fn show(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::Array(a) => format!("[{}]", a.iter().map(show).collect::<Vec<_>>().join(", ")),
        other => other.to_string(),
    }
}

pub fn stringify(meta: &Meta, body: &str) -> String {
    let mut lines = Vec::new();
    for (k, v) in meta {
        let empty = match v {
            Value::Null => true,
            Value::String(s) => s.is_empty(),
            Value::Array(a) => a.is_empty(),
            _ => false,
        };
        if !empty {
            lines.push(format!("{k}: {}", show(v)));
        }
    }
    format!("---\n{}\n---\n\n{}", lines.join("\n"), body.trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 머리말을_읽고_다시_쓴다() {
        let (meta, body) = parse("---\ntitle: 계류\naliases: [溪流, '계곡 물길']\norder: 10\n---\n\n본문");
        assert_eq!(meta["title"], "계류");
        assert_eq!(meta["aliases"], serde_json::json!(["溪流", "계곡 물길"]));
        assert_eq!(meta["order"], 10);
        assert_eq!(body, "\n본문");
        assert_eq!(stringify(&meta, &body), "---\ntitle: 계류\naliases: [溪流, 계곡 물길]\norder: 10\n---\n\n본문");
    }

    #[test]
    fn 머리말이_없으면_본문_그대로() {
        let (meta, body) = parse("# 제목\n본문");
        assert!(meta.is_empty());
        assert_eq!(body, "# 제목\n본문");
    }
}
