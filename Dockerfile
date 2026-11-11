# NAS(시놀로지 Container Manager 등)에서 돌릴 때. 문서 · 계정 · 임베딩 모델은 /data 볼륨에 둔다.
# 2026.11.09 : 서버가 Rust 로 바뀌었다. alpine(musl)은 onnxruntime 미리 빌드한 판이 없어 debian 을 쓴다.
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /app/server
COPY server/ ./
RUN cargo build --release

FROM debian:bookworm-slim
# git : 문서 저장 · 이력 / ca-certificates : 처음 켤 때 임베딩 모델을 Hugging Face 에서 받는다
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/server/target/release/seesun-wiki /app/seesun-wiki
COPY --from=web /app/web/dist web/dist
ENV WIKI_HOST=0.0.0.0 WIKI_PORT=4500 WIKI_DATA=/data
VOLUME /data
EXPOSE 4500
CMD ["/app/seesun-wiki"]
