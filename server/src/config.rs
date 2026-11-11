// 설정은 환경변수로만 받는다. NAS 로 옮길 때 코드를 고치지 않고 값만 바꾸게.
use std::path::PathBuf;
use std::sync::OnceLock;

pub struct Config {
    pub root: PathBuf,        // web/dist 를 찾는 자리. 실행한 폴더(저장소 맨 위)다
    pub host: String,         // NAS 에서는 0.0.0.0
    pub port: u16,
    pub data_dir: PathBuf,
    pub site_name: String,
    pub public_url: String,   // 외부에서 접속하는 주소. MCP 연결 안내문에 그대로 찍힌다
    pub content_dir: PathBuf, // 문서 git 저장소
    pub users_file: PathBuf,
    pub secret_file: PathBuf,
    pub settings_file: PathBuf,
    pub embed: String,        // 임베딩 모델 : gemma-q4(기본 · 4비트) · gemma(원판) · off
    pub models_dir: PathBuf,  // 받은 모델을 둘 곳 (기본 data/models)
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

pub fn get() -> &'static Config {
    static C: OnceLock<Config> = OnceLock::new();
    C.get_or_init(|| {
        // 2026.11.09 : Node 판은 소스 위치에서 root 를 셌다. 바이너리는 target/ 안에 있어 그렇게 못 하므로 실행 폴더를 쓴다.
        let root = env("WIKI_ROOT").map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().expect("실행 폴더"));
        let data_dir = env("WIKI_DATA").map(PathBuf::from).unwrap_or_else(|| root.join("data"));
        let data_dir = std::path::absolute(&data_dir).unwrap_or(data_dir);
        Config {
            host: env("WIKI_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: env("WIKI_PORT").and_then(|p| p.parse().ok()).unwrap_or(4500),
            site_name: env("WIKI_NAME").unwrap_or_else(|| "Seesun Wiki".into()),
            public_url: env("WIKI_PUBLIC_URL").unwrap_or_default(),
            embed: env("WIKI_EMBED").unwrap_or_else(|| "gemma-q4".into()),
            // Windows 는 260자 넘는 경로를 onnxruntime 이 열지 못한다. 모델 파일 경로가 이 폴더 뒤로 약 140자 붙으므로
            // 깊은 폴더에 data 를 둘 때는 WIKI_MODELS 를 짧은 경로로 준다.
            models_dir: env("WIKI_MODELS").map(PathBuf::from).unwrap_or_else(|| data_dir.join("models")),
            content_dir: data_dir.join("content"),
            users_file: data_dir.join("users.json"),
            secret_file: data_dir.join("secret"),
            settings_file: data_dir.join("settings.json"),
            data_dir,
            root,
        }
    })
}
