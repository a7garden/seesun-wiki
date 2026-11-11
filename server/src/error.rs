// 요청 처리 중 사람에게 알릴 오류. status 가 없는 오류(git 실패 등)는 500 「서버에서 처리하지 못했습니다」로 감춘다.
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
    /// 충돌(409) 때 지금 그 문서의 마지막 커밋. 편집 화면이 이 값으로 다시 읽을지 정한다.
    pub current: Option<Option<String>>,
}

pub fn http(status: u16, message: impl Into<String>) -> HttpError {
    HttpError { status, message: message.into(), current: None }
}

pub type Res<T> = Result<T, AppError>;

#[derive(Debug)]
pub enum AppError {
    Http(HttpError),
    Internal(anyhow::Error),
}

impl From<HttpError> for AppError {
    fn from(e: HttpError) -> Self {
        AppError::Http(e)
    }
}
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e)
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.into())
    }
}

impl AppError {
    /// 사람에게 보일 말. MCP 도구 결과에도 쓴다.
    pub fn message(&self) -> String {
        match self {
            AppError::Http(h) => h.message.clone(),
            AppError::Internal(e) => format!("서버에서 처리하지 못했습니다 ({e})"),
        }
    }
    pub fn status(&self) -> Option<u16> {
        match self {
            AppError::Http(h) => Some(h.status),
            AppError::Internal(_) => None,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::Http(h) => {
                let mut body = json!({ "error": h.message });
                if let Some(cur) = h.current {
                    body["current"] = json!(cur);
                }
                (StatusCode::from_u16(h.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(body)).into_response()
            }
            AppError::Internal(e) => {
                eprintln!("{e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "서버에서 처리하지 못했습니다" }))).into_response()
            }
        }
    }
}
