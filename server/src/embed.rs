// 뜻 검색 : 문서 단락(pages::sections)마다 EmbeddingGemma 로 벡터를 만들고, 찾을 말과 코사인 유사도로 견준다.
//
// - 모델은 서버를 켤 때 뒤에서 불러온다(처음 한 번은 Hugging Face 에서 받아 data/models 에 둔다).
//   준비되기 전 · 받지 못했을 때는 낱말 검색만 쓴다. 검색이 멈추면 안 되기 때문이다.
// - 단락 벡터는 data/embeddings/<모델>.json 에 「모델에 넣은 글」의 해시로 둔다. 저장할 때 바뀐 단락만 다시 만든다.
// - 단락은 몇 개씩 나눠 임베딩하고 그 사이에 모델을 놓는다. 한꺼번에 하면 처음 색인(수십 초~수 분) 동안
//   검색 질의도 모델을 기다려 모든 검색이 멈췄다(2026.11.09 리뷰).
// - EmbeddingGemma 는 정해진 접두어를 붙여야 성능이 난다. 빼먹어도 오류 없이 결과만 나빠진다.
//     찾을 말 : 「task: search result | query: 」   문서 : 「title: <제목> | text: 」
//
// 목차 : 단락 → 모델 입력 · 모델 준비 · 단락 벡터 다시 만들기 · 찾기(단락 · 문서)
use crate::pages::{Chunk, Wiki};
use std::sync::Arc;

/// 문서 하나에서 가장 가까운 단락 (search 의 문서 결과용)
#[derive(Clone)]
pub struct Match {
    pub path: String,
    pub score: f32,
    pub text: String, // 그 단락 글(검색 결과 아래 보일 글)
}

/// 가까운 단락 하나 (retrieve 의 근거용)
#[derive(Clone)]
pub struct ChunkMatch {
    pub chunk: Chunk,
    pub score: f32,
}

/// 단락을 모델에 넣을 글. 제목 · 별칭 · 단락 제목을 앞에 붙여, 「계류 › 정의」처럼 짧은 단락도 무엇에 관한 글인지 알게 한다.
/// 매뉴얼은 권 이름도 앞에 붙인다(「위키 사용법 › 글쓰기 표준」). 권이 여럿이면 「설정」 같은 같은 이름의 절을 구별하지 못한다.
/// 위키 묶음(산사태 · 공통)은 넣지 않는다 — 묶음은 검색 범위로 거르고, 넣으면 문서를 옮길 때마다 벡터를 모두 다시 만든다.
/// 이 글을 바꾸면 해시가 바뀌어 다음에 켤 때 단락 벡터를 모두 다시 만든다.
pub fn model_input(c: &Chunk, aliases: &[String]) -> String {
    let title = if c.volume.is_empty() { c.title.clone() } else { format!("{} › {}", c.volume, c.title) };
    let name = if aliases.is_empty() { title } else { format!("{title} ({})", aliases.join(", ")) };
    let head = if c.heading.is_empty() { name } else { format!("{name} - {}", c.heading) };
    format!("title: {head} | text: {}", c.text)
}

#[cfg(feature = "embed")]
mod imp {
    use super::*;
    use crate::config;
    use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::sync::{Mutex, MutexGuard, OnceLock, RwLock};

    /// 한 번에 모델에 넣는 단락 수. 이 묶음 하나가 끝날 때마다 모델을 놓아 검색 질의가 끼어들게 한다(CPU 에서 묶음 하나 1초 남짓).
    const BATCH: usize = 4;

    struct Embedder {
        name: &'static str,
        model: Mutex<TextEmbedding>,
        chunks: RwLock<Vec<(Chunk, Vec<f32>)>>,
        queries: Mutex<HashMap<String, Vec<f32>>>, // 같은 말을 거듭 찾을 때 모델을 다시 돌리지 않게
        min: f32,
    }

    /// 잠금. 다른 스레드가 잠근 채 패닉(모델 실행 실패 등)해도 계속 쓴다 — 안 그러면 서버를 다시 켤 때까지 모든 검색이 실패한다.
    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    static READY: OnceLock<Embedder> = OnceLock::new();
    // 아직 단락 색인에 넣지 않은 가장 새 문서 목록. 모델을 받는 동안 들어온 것도 여기서 기다린다.
    static PENDING: Mutex<Option<Arc<Wiki>>> = Mutex::new(None);
    // 단락 색인 다시 만들기는 한 번에 하나만. 저장이 잇달면 늘 가장 새 목록으로 돈다(옛 목록이 새것을 덮지 않게).
    static SYNC: Mutex<()> = Mutex::new(());

    // 2026.11.09 : 8비트 판(EmbeddingGemma300MQ)은 묶음마다 값 범위를 다시 잡는 동적 양자화라
    //              따로 만든 단락 벡터 · 질의 벡터를 견줄 수 없다(fastembed 도 묶음 처리를 막는다). 그래서 뺐다.
    fn pick(name: &str) -> Option<(EmbeddingModel, &'static str)> {
        Some(match name {
            "gemma" => (EmbeddingModel::EmbeddingGemma300M, "embeddinggemma-300m"),
            "gemma-q4" => (EmbeddingModel::EmbeddingGemma300MQ4, "embeddinggemma-300m-q4"),
            _ => return None,
        })
    }

    pub fn start() {
        let c = config::get();
        let Some((model, name)) = pick(&c.embed) else {
            if c.embed != "off" {
                println!("임베딩 : WIKI_EMBED={} 는 모르는 모델이라 낱말 검색만 씁니다 (gemma-q4 · gemma · off)", c.embed);
            }
            return;
        };
        // 2026.11.09 : 0.35. 실제 문서 18장에 견줘 보니 관련 없는 질의(점심 메뉴 · 주식 · 자바 설정)는 0.24 아래,
        //              뜻으로 바꿔 물은 질의의 정답은 0.35~0.65 였다. 문서가 늘면 다시 잰다(결과의 similarity 칸).
        let min = std::env::var("WIKI_EMBED_MIN").ok().and_then(|v| v.parse().ok()).unwrap_or(0.35);
        let cache = c.models_dir.clone();
        std::thread::spawn(move || {
            let t = std::time::Instant::now();
            let opts = TextInitOptions::new(model).with_cache_dir(cache).with_show_download_progress(false);
            match TextEmbedding::try_new(opts) {
                Ok(m) => {
                    let _ = READY.set(Embedder { name, model: Mutex::new(m), chunks: RwLock::new(vec![]), queries: Mutex::new(HashMap::new()), min });
                    println!("임베딩 : {name} 준비 ({:.1}초)", t.elapsed().as_secs_f32());
                    drain();
                }
                Err(e) => println!("임베딩 : 모델을 불러오지 못해 낱말 검색만 씁니다 ({e})"),
            }
        });
    }

    fn cache_file(name: &str) -> std::path::PathBuf {
        config::get().data_dir.join("embeddings").join(format!("{name}.json"))
    }

    fn hash(s: &str) -> String {
        hex::encode(Sha256::digest(s.as_bytes()))[..32].to_string()
    }

    /// 문서가 바뀔 때마다 부른다. 모델이 아직이면 맡겨 두고 바로 돌아온다.
    pub fn sync(wiki: Arc<Wiki>) {
        *lock(&PENDING) = Some(wiki);
        if READY.get().is_some() {
            std::thread::spawn(drain);
        }
    }

    fn drain() {
        let _g = lock(&SYNC);
        let next = lock(&PENDING).take();
        if let Some(w) = next {
            rebuild(&w);
        }
    }

    fn rebuild(wiki: &Wiki) {
        let Some(e) = READY.get() else { return };
        let t = std::time::Instant::now();
        let file = cache_file(e.name);
        let mut cache: HashMap<String, Vec<f32>> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();

        // (단락, 해시, 모델에 넣을 글)
        let items: Vec<(&Chunk, String, String)> = wiki
            .chunks()
            .iter()
            .map(|c| {
                let aliases = wiki.get(&c.path).map(|p| p.aliases.clone()).unwrap_or_default();
                let input = model_input(c, &aliases);
                (c, hash(&input), input)
            })
            .collect();
        let todo: Vec<&(&Chunk, String, String)> = items.iter().filter(|x| !cache.contains_key(&x.1)).collect();
        let fresh = todo.len();
        for batch in todo.chunks(BATCH) {
            let inputs: Vec<&str> = batch.iter().map(|x| x.2.as_str()).collect();
            let res = lock(&e.model).embed(&inputs, Some(BATCH)); // 묶음 하나가 끝나면 잠금이 풀린다
            match res {
                Ok(vecs) => {
                    for (x, v) in batch.iter().zip(vecs) {
                        cache.insert(x.1.clone(), normalize(v));
                    }
                }
                Err(err) => {
                    println!("임베딩 : 단락 {}개를 만들지 못했습니다 ({err})", batch.len());
                    return;
                }
            }
        }
        // 지금 쓰는 단락만 남겨 파일이 끝없이 불지 않게 한다.
        let keep: std::collections::HashSet<&str> = items.iter().map(|x| x.1.as_str()).collect();
        cache.retain(|k, _| keep.contains(k.as_str()));
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&cache).unwrap()).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }

        let next: Vec<(Chunk, Vec<f32>)> = items.iter().filter_map(|(c, h, _)| Some(((*c).clone(), cache.get(h)?.clone()))).collect();
        if fresh > 0 {
            println!("임베딩 : 단락 {}개 중 {fresh}개를 새로 만듦 ({:.1}초)", next.len(), t.elapsed().as_secs_f32());
        }
        *e.chunks.write().unwrap_or_else(|p| p.into_inner()) = next;
    }

    fn normalize(mut v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            v.iter_mut().for_each(|x| *x /= n);
        }
        v
    }

    fn query_vec(e: &Embedder, q: &str) -> Option<Vec<f32>> {
        if let Some(v) = lock(&e.queries).get(q) {
            return Some(v.clone());
        }
        let input = format!("task: search result | query: {q}");
        let v = normalize(lock(&e.model).embed([input.as_str()], None).ok()?.into_iter().next()?);
        let mut qs = lock(&e.queries);
        if qs.len() > 500 {
            qs.clear();
        }
        qs.insert(q.to_string(), v.clone());
        Some(v)
    }

    /// 1등보다 이만큼 넘게 먼 것은 뺀다. 같은 분야 문서는 서로 0.35~0.5 로 다 비슷해서, 절대 기준만 두면 결과가 늘 길다.
    const SPREAD: f32 = 0.15;

    /// 모든 단락의 (단락, 유사도). 기준(WIKI_EMBED_MIN)보다 멀거나 1등과 너무 벌어진 것은 뺀다. 가까운 순.
    fn scored(q: &str) -> Vec<(Chunk, f32)> {
        let Some(e) = READY.get() else { return vec![] };
        let Some(qv) = query_vec(e, q) else { return vec![] };
        let chunks = e.chunks.read().unwrap_or_else(|p| p.into_inner());
        let mut all: Vec<(&Chunk, f32)> = chunks.iter().map(|(c, v)| (c, v.iter().zip(&qv).map(|(a, b)| a * b).sum())).collect();
        let top = all.iter().map(|x| x.1).fold(f32::MIN, f32::max);
        let floor = e.min.max(top - SPREAD);
        all.retain(|x| x.1 >= floor);
        all.sort_by(|a, b| b.1.total_cmp(&a.1));
        all.into_iter().map(|(c, s)| (c.clone(), s)).collect()
    }

    /// 가까운 단락 k 개 (RAG 근거)
    pub fn nearest_chunks(q: &str, k: usize) -> Vec<ChunkMatch> {
        let mut v = scored(q);
        v.truncate(k);
        v.into_iter().map(|(chunk, score)| ChunkMatch { chunk, score }).collect()
    }

    /// 문서마다 가장 가까운 단락 하나씩, 가까운 순 (검색 결과)
    pub fn nearest(q: &str, k: usize) -> Vec<Match> {
        let mut seen = std::collections::HashSet::new();
        scored(q)
            .into_iter()
            .filter(|(c, _)| seen.insert(c.path.clone()))
            .take(k)
            .map(|(c, s)| Match { path: c.path, score: s, text: if c.heading.is_empty() { c.text } else { format!("{} — {}", c.heading, c.text) } })
            .collect()
    }

    pub fn status() -> serde_json::Value {
        match READY.get() {
            Some(e) => serde_json::json!({ "model": e.name, "chunks": e.chunks.read().unwrap_or_else(|p| p.into_inner()).len(), "min": e.min }),
            None => serde_json::Value::Null,
        }
    }
}

#[cfg(not(feature = "embed"))]
mod imp {
    use super::*;
    pub fn start() {}
    pub fn sync(_: Arc<Wiki>) {}
    pub fn nearest(_: &str, _: usize) -> Vec<Match> {
        vec![]
    }
    pub fn nearest_chunks(_: &str, _: usize) -> Vec<ChunkMatch> {
        vec![]
    }
    pub fn status() -> serde_json::Value {
        serde_json::Value::Null
    }
}

pub use imp::{nearest, nearest_chunks, start, status, sync};
