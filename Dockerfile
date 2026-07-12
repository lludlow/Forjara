ARG GO_VERSION=1.24
ARG ZIG_VERSION=0.15.2

FROM golang:${GO_VERSION}-bookworm AS forjara-web
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/forjara-web ./cmd/forjara-web

FROM debian:bookworm-slim AS ghostty-wasm
ARG TARGETARCH
ARG ZIG_VERSION
ARG GHOSTTY_COMMIT=d31ac2be380de05dbcded8b35302fbb43281364a
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in amd64) zig_arch=x86_64 ;; arm64) zig_arch=aarch64 ;; *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; esac \
 && curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz" \
      | tar -xJ -C /opt \
 && ln -s "/opt/zig-${zig_arch}-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig \
 && git init /src \
 && git -C /src remote add origin https://github.com/ghostty-org/ghostty.git \
 && git -C /src fetch --depth=1 origin "$GHOSTTY_COMMIT" \
 && git -C /src checkout --detach FETCH_HEAD
WORKDIR /src
RUN zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall

FROM node:22-bookworm-slim

ARG CODE_SERVER_VERSION=4.121.0
ARG TARGETARCH
ARG GOOGLE_AGENT=antigravity

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less openssh-client ripgrep tini tmux \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1;; esac \
 && curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /opt \
 && ln -s "/opt/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}/bin/code-server" /usr/local/bin/code-server \
 && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
 && npm cache clean --force

COPY install-google-agent.sh /tmp/
RUN /tmp/install-google-agent.sh "$GOOGLE_AGENT" && rm /tmp/install-google-agent.sh

RUN install -d -o node -g node /config /opt/forjara \
 && install -d /usr/share/licenses/ghostty

COPY --from=forjara-web /out/forjara-web /usr/local/bin/forjara-web
COPY --from=ghostty-wasm /src/zig-out/bin/ghostty-vt.wasm /opt/forjara/ghostty-vt.wasm
COPY third_party/ghostty/LICENSE /usr/share/licenses/ghostty/LICENSE
COPY --chmod=755 start-forjara.sh /usr/local/bin/

ENV HOME=/config \
    FORJARA_SERVICES=vscode,web \
    FORJARA_WORKSPACE=/workspace \
    FORJARA_STATE_DIR=/config/.local/state/forjara \
    FORJARA_EVENT_SOCKET=/config/.local/state/forjara/events.sock \
    FORJARA_GHOSTTY_WASM=/opt/forjara/ghostty-vt.wasm
USER node
WORKDIR /workspace
EXPOSE 8080 8443
ENTRYPOINT ["tini", "-g", "--", "start-forjara.sh"]
CMD ["--bind-addr", "0.0.0.0:8443", "--auth", "none", "/workspace"]
