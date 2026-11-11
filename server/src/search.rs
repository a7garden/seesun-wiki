// 검색 : 낱말 검색(tantivy · BM25)과 뜻 검색(임베딩)을 RRF 로 합친다.
//
// 낱말 검색의 토크나이저는 한글 · 한자를 <글자 하나 + 이웃 두 글자>로 쪼갠다.
//   기본 토크나이저는 어절 통째(「유출구가」)를 토큰 하나로 삼아 「유출구」로 찾지 못한다.
//   두 글자씩 쪼개면 조사 · 띄어쓰기가 달라도(「유출구가」 · 「유출 구」) 같은 토큰이 겹쳐 찾힌다.
//   형태소 사전(lindera)은 산림 전문용어를 사용자 사전으로 따로 넣어야 해서 쓰지 않았다(2026.11.09).
// 영문 · 숫자는 낱말 통째로 둔다(「MCP」 · 「D14」).
//
// 목차
//   1. 토크나이저   : 색인 토큰(한 글자 + 두 글자) · 찾을 말 토큰(두 글자)
//   2. 낱말 색인    : 저장할 때마다 메모리에 새로 만드는 tantivy 색인 · BM25 질의
//   2-1. 단락 색인  : 문서를 「## · ###」 단락으로 나눈 색인 (근거 찾기용)
//   3. 합치기       : 낱말 순위 + 뜻 순위 → RRF · 결과 아래 보일 조각
//   4. 근거 찾기    : RAG 용 단락 검색 (retrieve) — 답변 모델에 넘길 근거와 인용 주소
use crate::embed;
use crate::pages::{Brief, Chunk, Page, Wiki, plain};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, Query, TermQuery};
use tantivy::schema::{Field, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions, Value};
use tantivy::tokenizer::{Token, TokenStream, Tokenizer};
use tantivy::{IndexReader, TantivyDocument, Term, doc};

// ── 1. 토크나이저

#[derive(Clone, Copy, PartialEq)]
enum Class {
    Sep,
    Word, // 영문 · 숫자 · 그 밖의 글자
    Cjk,  // 한글 · 한자 · 가나 : 띄어쓰기로 낱말이 갈리지 않는 글자
}

fn class(c: char) -> Class {
    let u = c as u32;
    let cjk = matches!(u, 0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF);
    if cjk {
        Class::Cjk
    } else if c.is_alphanumeric() {
        Class::Word
    } else {
        Class::Sep
    }
}

/// 같은 갈래 글자가 이어진 덩어리 (갈래, 바이트 시작, (바이트 자리, 글자)들)
type Run = (Class, usize, Vec<(usize, char)>);

fn runs(text: &str) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for (i, c) in text.char_indices() {
        let k = class(c);
        if k == Class::Sep {
            continue;
        }
        match out.last_mut() {
            Some((lk, _, chars)) if *lk == k && chars.last().map(|(j, p)| j + p.len_utf8()) == Some(i) => chars.push((i, c)),
            _ => out.push((k, i, vec![(i, c)])),
        }
    }
    out
}

fn lower(c: char) -> String {
    c.to_lowercase().collect()
}

/// 색인할 토큰 : 한글은 글자 하나 + 두 글자, 낱말은 통째. (글자, 시작, 끝)
fn index_tokens(text: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    for (k, start, chars) in runs(text) {
        let end_of = |j: usize| chars[j].0 + chars[j].1.len_utf8();
        match k {
            Class::Word => out.push((chars.iter().map(|(_, c)| lower(*c)).collect(), start, end_of(chars.len() - 1))),
            Class::Cjk => {
                for j in 0..chars.len() {
                    out.push((lower(chars[j].1), chars[j].0, end_of(j)));
                    if j + 1 < chars.len() {
                        out.push((format!("{}{}", lower(chars[j].1), lower(chars[j + 1].1)), chars[j].0, end_of(j + 1)));
                    }
                }
            }
            Class::Sep => {}
        }
    }
    out
}

/// 찾을 말의 토큰 : 두 글자 넘는 한글 덩어리는 두 글자씩만(한 글자는 너무 흔해 순위를 흐린다).
fn query_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (k, _, chars) in runs(text) {
        match k {
            Class::Word => out.push(chars.iter().map(|(_, c)| lower(*c)).collect()),
            Class::Cjk if chars.len() == 1 => out.push(lower(chars[0].1)),
            Class::Cjk => {
                for w in chars.windows(2) {
                    out.push(format!("{}{}", lower(w[0].1), lower(w[1].1)));
                }
            }
            Class::Sep => {}
        }
    }
    out
}

#[derive(Clone)]
struct KoTokenizer;

struct VecStream {
    tokens: Vec<Token>,
    i: usize,
}

impl TokenStream for VecStream {
    fn advance(&mut self) -> bool {
        self.i += 1;
        self.i <= self.tokens.len()
    }
    fn token(&self) -> &Token {
        &self.tokens[self.i - 1]
    }
    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.i - 1]
    }
}

impl Tokenizer for KoTokenizer {
    type TokenStream<'a> = VecStream;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> VecStream {
        let tokens = index_tokens(text)
            .into_iter()
            .enumerate()
            .map(|(position, (text, from, to))| Token { offset_from: from, offset_to: to, position, text, position_length: 1 })
            .collect();
        VecStream { tokens, i: 0 }
    }
}

// ── 2. 낱말 색인

pub struct Index {
    reader: IndexReader,
    path: Field,
    title: Field,
    aliases: Field,
    body: Field,
}

impl Index {
    pub fn build<'a>(pages: impl Iterator<Item = &'a Page>) -> tantivy::Result<Index> {
        let mut sb = Schema::builder();
        let ko = ko_schema();
        let path = sb.add_text_field("path", STRING | STORED);
        let title = sb.add_text_field("title", ko.clone());
        let aliases = sb.add_text_field("aliases", ko.clone());
        let body = sb.add_text_field("body", ko);
        let index = tantivy::Index::create_in_ram(sb.build());
        index.tokenizers().register("ko", KoTokenizer);
        let mut w = index.writer_with_num_threads::<TantivyDocument>(1, 15_000_000)?;
        for pg in pages {
            w.add_document(doc!(path => pg.path.clone(), title => pg.title.clone(), aliases => pg.aliases.join(" "), body => plain(&pg.body)))?;
        }
        w.commit()?;
        Ok(Index { reader: index.reader()?, path, title, aliases, body })
    }

    /// (경로, BM25 점수) 높은 순
    fn query(&self, q: &str) -> Vec<(String, f32)> {
        run(&self.reader, self.path, q, &[(self.title, 3.0), (self.aliases, 2.0), (self.body, 1.0)], 100)
    }
}

/// 찾을 말을 토큰으로 쪼개 여러 칸(가중치)에 걸쳐 BM25 로 찾는다. (key 칸 값, 점수) 높은 순.
fn run(reader: &IndexReader, key: Field, q: &str, fields: &[(Field, f32)], limit: usize) -> Vec<(String, f32)> {
    let words: Vec<&str> = q.split_whitespace().collect();
    let mut tokens: Vec<String> = Vec::new();
    for t in words.iter().flat_map(|w| query_tokens(w)) {
        if !tokens.contains(&t) {
            tokens.push(t);
        }
    }
    let needed = tokens.len();
    // 띄어 쓴 말을 붙인 꼴의 토큰도 더한다 : 「유출 구」가 「유출구」의 「출구」와도 겹치게.
    for t in query_tokens(&words.concat()) {
        if !tokens.contains(&t) {
            tokens.push(t);
        }
    }
    if tokens.is_empty() {
        return vec![];
    }
    let per_token: Vec<Box<dyn Query>> = tokens
        .iter()
        .map(|t| {
            let terms = fields
                .iter()
                .map(|&(f, boost)| -> Box<dyn Query> {
                    let q = TermQuery::new(Term::from_field_text(f, t), IndexRecordOption::WithFreqs);
                    if boost == 1.0 { Box::new(q) } else { Box::new(BoostQuery::new(Box::new(q), boost)) }
                })
                .collect();
            Box::new(BooleanQuery::union(terms)) as Box<dyn Query>
        })
        .collect();
    // 찾을 말 토큰의 6할 넘게 겹쳐야 결과로 낸다. 두 글자 말(토큰 하나)은 그 토큰이 꼭 있어야 한다.
    let min = ((needed as f32) * 0.6).ceil().max(1.0) as usize;
    let query = BooleanQuery::union_with_minimum_required_clauses(per_token, min);
    let searcher = reader.searcher();
    let Ok(top) = searcher.search(&query, &TopDocs::with_limit(limit).order_by_score()) else { return vec![] };
    top.into_iter()
        .filter_map(|(score, addr)| {
            let d: TantivyDocument = searcher.doc(addr).ok()?;
            Some((d.get_first(key)?.as_str()?.to_string(), score))
        })
        .collect()
}

fn ko_schema() -> TextOptions {
    TextOptions::default().set_indexing_options(TextFieldIndexing::default().set_tokenizer("ko").set_index_option(IndexRecordOption::WithFreqs))
}

// ── 2-1. 단락 색인

/// 단락 색인 : RAG 근거 찾기(retrieve)에 쓴다. 문서 하나가 아니라 단락 하나가 한 건이다.
pub struct ChunkIndex {
    reader: IndexReader,
    id: Field,
    title: Field,
    heading: Field,
    text: Field,
}

impl ChunkIndex {
    pub fn build(chunks: &[Chunk]) -> tantivy::Result<ChunkIndex> {
        let mut sb = Schema::builder();
        let id = sb.add_text_field("id", STRING | STORED);
        let title = sb.add_text_field("title", ko_schema());
        let heading = sb.add_text_field("heading", ko_schema());
        let text = sb.add_text_field("text", ko_schema());
        let index = tantivy::Index::create_in_ram(sb.build());
        index.tokenizers().register("ko", KoTokenizer);
        let mut w = index.writer_with_num_threads::<TantivyDocument>(1, 15_000_000)?;
        for (i, c) in chunks.iter().enumerate() {
            w.add_document(doc!(id => i.to_string(), title => c.title.clone(), heading => c.heading.clone(), text => c.text.clone()))?;
        }
        w.commit()?;
        Ok(ChunkIndex { reader: index.reader()?, id, title, heading, text })
    }

    /// (단락 번호, BM25 점수) 높은 순
    fn query(&self, q: &str, limit: usize) -> Vec<(usize, f32)> {
        run(&self.reader, self.id, q, &[(self.title, 1.5), (self.heading, 2.0), (self.text, 1.0)], limit).into_iter().filter_map(|(i, s)| Some((i.parse().ok()?, s))).collect()
    }
}

// ── 3. 합치기

#[derive(Serialize)]
pub struct Hit {
    #[serde(flatten)]
    pub brief: Brief,
    pub score: f32,
    pub snippet: String,
    /// keyword · semantic · both. 어느 쪽 검색이 찾았는지 (순위를 손볼 때 본다)
    pub via: &'static str,
    /// 뜻 검색의 코사인 유사도. 기준(WIKI_EMBED_MIN)을 다시 맞출 때 본다
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f32>,
}

const RRF_K: f32 = 60.0;

/// scope : 찾을 묶음. 그 묶음과 공통에서만 찾는다. 비었으면 위키 전체.
pub fn search(wiki: &crate::pages::Wiki, q: &str, limit: usize, scope: &str) -> Vec<Hit> {
    let q = q.trim();
    if q.is_empty() {
        return vec![];
    }
    let words: Vec<String> = q.to_lowercase().split_whitespace().map(String::from).collect();

    // 낱말 검색 : BM25 에 제목이 그대로 맞으면 더 얹는다(「계류」를 찾으면 「계류」 문서가 맨 위).
    let mut keyword: Vec<(String, f32)> = wiki
        .index
        .query(q)
        .into_iter()
        .filter(|(p, _)| wiki.in_scope(p, scope))
        .filter_map(|(p, s)| {
            let pg = wiki.get(&p)?;
            let title = pg.title.to_lowercase();
            let aliases: Vec<String> = pg.aliases.iter().map(|a| a.to_lowercase()).collect();
            let mut bonus = 0.0;
            if title == q.to_lowercase() || aliases.iter().any(|a| *a == q.to_lowercase()) {
                bonus += 50.0;
            }
            for w in &words {
                if title.contains(w.as_str()) {
                    bonus += 10.0;
                }
                if aliases.iter().any(|a| a.contains(w.as_str())) {
                    bonus += 5.0;
                }
            }
            Some((p, s + bonus))
        })
        .collect();
    keyword.sort_by(|a, b| b.1.total_cmp(&a.1));

    // 뜻 검색 : 모델이 준비되지 않았으면 빈 목록(낱말 검색만으로 낸다).
    // 묶음으로 거르면 남는 것이 줄어드므로 넉넉히 받는다.
    let semantic: Vec<_> = embed::nearest(q, if scope.is_empty() { 30 } else { 60 }).into_iter().filter(|m| wiki.in_scope(&m.path, scope)).collect();

    let mut fused: HashMap<String, (f32, bool, bool)> = HashMap::new();
    for (rank, (p, _)) in keyword.iter().enumerate() {
        let e = fused.entry(p.clone()).or_insert((0.0, false, false));
        e.0 += 1.0 / (RRF_K + rank as f32 + 1.0);
        e.1 = true;
    }
    let mut chunk_of: HashMap<String, (String, f32)> = HashMap::new();
    for (rank, m) in semantic.iter().enumerate() {
        let e = fused.entry(m.path.clone()).or_insert((0.0, false, false));
        e.0 += 1.0 / (RRF_K + rank as f32 + 1.0);
        e.2 = true;
        chunk_of.entry(m.path.clone()).or_insert_with(|| (m.text.clone(), m.score));
    }

    let mut out: Vec<Hit> = fused
        .into_iter()
        .filter_map(|(p, (score, kw, sem))| {
            let pg = wiki.get(&p)?;
            let sem_of = chunk_of.get(&p);
            let snippet = snippet(&pg.body, &words, sem_of.map(|x| x.0.as_str()));
            let via = if kw && sem { "both" } else if kw { "keyword" } else { "semantic" };
            Some(Hit { brief: pg.brief(), score, snippet, via, similarity: sem_of.map(|x| x.1) })
        })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.brief.path.cmp(&b.brief.path)));
    out.truncate(limit);
    out
}

// ── 4. 근거 찾기 (RAG)
//
// 답변을 만들 모델에 넘길 근거 단락을 찾는다. search 와 같은 두 검색을 단락 단위로 돌려 RRF 로 합친다.
// 결과마다 화면 주소(url · 제목 앵커까지)가 붙어, 답변이 「어느 문서 어느 단락」을 근거로 댈 수 있다.
// 답을 만드는 단계(LLM 호출)는 아직 없다 — 이 목록을 모델에 문서 블록으로 넘기고 인용을 켜면 된다.

#[derive(Serialize)]
pub struct Passage {
    pub path: String,
    pub title: String,
    pub heading: String,
    pub anchor: String,
    pub url: String,
    pub text: String,
    pub score: f32,
    pub via: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f32>,
}

/// 단락을 낱말 · 뜻 검색 사이에서 같은 것으로 알아보는 열쇠. 두 검색이 보는 문서 목록 판이 다를 수 있어 번호 대신 내용으로 견준다.
fn chunk_key(c: &Chunk) -> (String, String, String) {
    (c.path.clone(), c.anchor.clone(), c.text.clone())
}

/// scope : search 와 같다. 챗봇이 한 사업 분야의 근거만 받게 할 때 쓴다.
pub fn retrieve(wiki: &Wiki, q: &str, k: usize, scope: &str) -> Vec<Passage> {
    let q = q.trim();
    if q.is_empty() {
        return vec![];
    }
    let chunks = wiki.chunks();
    let wide = if scope.is_empty() { 50 } else { 100 };
    let keyword: Vec<_> = wiki.chunk_index.query(q, wide).into_iter().filter(|(i, _)| chunks.get(*i).is_some_and(|c| wiki.in_scope(&c.path, scope))).collect();
    let semantic: Vec<_> = embed::nearest_chunks(q, wide).into_iter().filter(|m| wiki.in_scope(&m.chunk.path, scope)).collect();

    struct Fused {
        score: f32,
        kw: bool,
        sem: bool,
        sim: Option<f32>,
        chunk: Chunk,
    }
    let new = |c: &Chunk| Fused { score: 0.0, kw: false, sem: false, sim: None, chunk: c.clone() };
    let mut fused: HashMap<(String, String, String), Fused> = HashMap::new();
    for (rank, (i, _)) in keyword.iter().enumerate() {
        let Some(c) = chunks.get(*i) else { continue };
        let e = fused.entry(chunk_key(c)).or_insert_with(|| new(c));
        e.score += 1.0 / (RRF_K + rank as f32 + 1.0);
        e.kw = true;
    }
    for (rank, m) in semantic.iter().enumerate() {
        let e = fused.entry(chunk_key(&m.chunk)).or_insert_with(|| new(&m.chunk));
        e.score += 1.0 / (RRF_K + rank as f32 + 1.0);
        e.sem = true;
        e.sim = Some(m.score);
    }
    let mut out: Vec<Passage> = fused
        .into_values()
        .map(|Fused { score, kw, sem, sim, chunk: c }| Passage {
            url: c.url(),
            path: c.path,
            title: c.title,
            heading: c.heading,
            anchor: c.anchor,
            text: c.text,
            score,
            via: if kw && sem { "both" } else if kw { "keyword" } else { "semantic" },
            similarity: sim,
        })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.url.cmp(&b.url)));
    out.truncate(k);
    out
}

/// 결과 아래 보일 한두 줄. 찾은 말이 처음 나오는 자리 앞뒤, 없으면 뜻 검색이 고른 단락 앞머리.
fn snippet(body: &str, words: &[String], chunk: Option<&str>) -> String {
    let text = plain(&body.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n"));
    let chars: Vec<char> = text.chars().collect();
    let low: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let mut seen = HashSet::new();
    for w in words.iter().filter(|w| seen.insert(w.as_str())) {
        let wc: Vec<char> = w.chars().collect();
        if wc.is_empty() || wc.len() > low.len() {
            continue;
        }
        if let Some(i) = (0..=low.len() - wc.len()).find(|&i| low[i..i + wc.len()] == wc[..]) {
            let s = i.saturating_sub(50);
            let e = (i + 90).min(chars.len());
            return format!("{}{}…", if s > 0 { "…" } else { "" }, chars[s..e].iter().collect::<String>());
        }
    }
    match chunk {
        Some(c) => {
            let n = c.chars().count();
            if n > 140 { format!("{}…", c.chars().take(140).collect::<String>()) } else { c.to_string() }
        }
        None => chars.iter().take(140).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 한글은_한_글자와_두_글자로_쪼갠다() {
        let t: Vec<String> = index_tokens("유출구가 MCP").into_iter().map(|x| x.0).collect();
        assert_eq!(t, vec!["유", "유출", "출", "출구", "구", "구가", "가", "mcp"]);
        assert_eq!(query_tokens("유출구"), vec!["유출", "출구"]);
        assert_eq!(query_tokens("물 D14"), vec!["물", "d14"]);
    }
}
