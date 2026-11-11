// 묶음 · 매뉴얼 권 목록 : data/content/bundles.json. 문서와 같은 git 저장소에 두어 바꿀 때마다 커밋으로 남는다.
//
// 2026.11.10 : 전에는 묶음 · 권이 문서 경로에서만 생겼고, 모든 묶음이 함께 보는 「공통」은 코드에 박혀 있었다.
//              편집자가 화면에서 묶음 · 권을 만들고, 어느 묶음이든 「공유 묶음」으로 정할 수 있게 목록을 따로 둔다.
//              목록에 없어도 문서 경로에 나오는 묶음 · 권은 그대로 보인다(목록은 설명 · 공유 여부 · 빈 묶음을 더할 뿐이다).
//
// 목차
//   1. 꼴     : Registry · BundleInfo · VolumeInfo
//   2. 검사   : 이름 규칙(종류 이름 · 경로에 못 쓰는 글자)
//   3. 처음   : 파일이 없을 때 지금 문서에서 목록을 만든다
use crate::pages::KINDS;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const FILE: &str = "bundles.json";

// ── 1. 꼴

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Registry {
    #[serde(default)]
    pub bundles: Vec<BundleInfo>,
    #[serde(default)]
    pub volumes: Vec<VolumeInfo>,
    #[serde(flatten)]
    pub rest: Map<String, Value>, // 이 판이 모르는 칸도 지우지 않고 그대로 둔다
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct BundleInfo {
    pub name: String,
    #[serde(default)]
    pub about: String,
    /// 공유 묶음 : 어느 묶음을 보든 함께 보인다. [[이름]] 이 지금 묶음에 없으면 여기서 찾는다.
    #[serde(default)]
    pub shared: bool,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct VolumeInfo {
    pub bundle: String,
    pub name: String,
    #[serde(default)]
    pub about: String,
    /// 묶음 안 권 순서. 없으면 그 권 문서 order 의 가장 작은 값을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Registry {
    pub fn parse(text: &str) -> Registry {
        serde_json::from_str(text).unwrap_or_else(|e| {
            eprintln!("{FILE} 를 읽지 못함 : {e} — 빈 목록으로 본다");
            Registry::default()
        })
    }
    pub fn to_text(&self) -> String {
        serde_json::to_string_pretty(self).unwrap() + "\n"
    }
    pub fn bundle(&self, name: &str) -> Option<&BundleInfo> {
        self.bundles.iter().find(|b| b.name == name)
    }
    pub fn volume(&self, bundle: &str, name: &str) -> Option<&VolumeInfo> {
        self.volumes.iter().find(|v| v.bundle == bundle && v.name == name)
    }
    /// 공유 묶음 이름들. 목록 차례대로다 — [[이름]] 을 이 차례로 찾는다.
    pub fn shared(&self) -> Vec<String> {
        self.bundles.iter().filter(|b| b.shared).map(|b| b.name.clone()).collect()
    }
}

// ── 2. 검사

/// 묶음 · 권 이름 : 경로 한 칸이 되므로 「/」 와 파일 이름에 못 쓰는 글자를 막는다.
pub fn check_name(name: &str, what: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(format!("{what} 이름을 넣어 주세요"));
    }
    if n.chars().count() > 40 {
        return Err(format!("{what} 이름은 40자까지입니다"));
    }
    if n == "." || n == ".." || n.chars().any(|c| matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*' | '#' | '[' | ']') || c.is_control()) {
        return Err(format!("{what} 이름에 / \\ < > : \" | ? * # [ ] 는 쓸 수 없습니다"));
    }
    Ok(n.to_string())
}

/// 묶음 이름은 종류 폴더 이름(개념 · 매뉴얼 · 틀)을 쓸 수 없다 — [[개념/계류]] 가 「개념」 묶음으로 읽힌다.
pub fn check_bundle_name(name: &str) -> Result<String, String> {
    let n = check_name(name, "묶음")?;
    if KINDS.contains(&n.as_str()) {
        return Err(format!("「{n}」은 문서 종류 이름이라 묶음 이름으로 쓸 수 없습니다"));
    }
    Ok(n)
}

// ── 3. 처음

/// 목록 파일이 없을 때 : 지금 문서 경로의 묶음을 모두 올리고, 그동안 코드가 공유 묶음으로 다루던 「공통」을 공유로 둔다.
/// 새 위키에도 「공통」 하나는 공유 묶음으로 깔아 둔다(위키 사용법 · 회사 공통 용어 자리). 이 한 번 뒤로는 파일이 정한다.
pub fn seed(bundles_in_pages: &[String]) -> Registry {
    const OLD_COMMON: &str = "공통";
    let mut reg = Registry::default();
    let mut names = bundles_in_pages.to_vec();
    if !names.iter().any(|b| b == OLD_COMMON) {
        names.push(OLD_COMMON.to_string());
    }
    for b in &names {
        let shared = b == OLD_COMMON;
        let about = if shared { "회사 전체가 같이 쓰는 용어 · 위키 사용법".to_string() } else { String::new() };
        reg.bundles.push(BundleInfo { name: b.clone(), about, shared, rest: Map::new() });
    }
    reg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 이름_검사() {
        assert!(check_bundle_name("개념").is_err());
        assert!(check_bundle_name("a/b").is_err());
        assert!(check_bundle_name("  ").is_err());
        assert_eq!(check_bundle_name(" 홍수 ").unwrap(), "홍수");
        assert!(check_name("위키 사용법", "권").is_ok());
    }

    #[test]
    fn 처음_목록은_공통을_공유로() {
        let r = seed(&["산사태".into(), "공통".into()]);
        assert_eq!(r.shared(), vec!["공통".to_string()]);
        assert!(!r.bundle("산사태").unwrap().shared);
    }

    #[test]
    fn 모르는_칸은_남긴다() {
        let r = Registry::parse(r#"{"bundles":[{"name":"a","shared":true,"color":"red"}],"x":1}"#);
        let t = r.to_text();
        assert!(t.contains("\"color\"") && t.contains("\"x\""));
    }
}
