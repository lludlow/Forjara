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

# Google agent is pluggable: Gemini CLI stopped serving consumer tiers
# 2026-06-18; consumers get Antigravity CLI (agy), enterprise/API-key
# accounts keep Gemini CLI.
COPY install-google-agent.sh /tmp/
RUN /tmp/install-google-agent.sh "$GOOGLE_AGENT" && rm /tmp/install-google-agent.sh

RUN install -d -o node -g node /config

COPY --chmod=755 start-code-server.sh /usr/local/bin/

ENV HOME=/config
USER node
WORKDIR /workspace
EXPOSE 8443
ENTRYPOINT ["start-code-server.sh"]
CMD ["--bind-addr", "0.0.0.0:8443", "--auth", "none", "/workspace"]
