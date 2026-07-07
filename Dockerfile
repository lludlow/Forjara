FROM lscr.io/linuxserver/code-server:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux ripgrep jq less openssh-client curl ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*

# Node 22 + the agent CLIs
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs \
 && npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
 && rm -rf /var/lib/apt/lists/*

# Google agent is pluggable: Gemini CLI stopped serving consumer tiers
# 2026-06-18; consumers get Antigravity CLI (agy), enterprise/API-key
# accounts keep Gemini CLI.
ARG GOOGLE_AGENT=antigravity
COPY install-google-agent.sh /tmp/
RUN /tmp/install-google-agent.sh "$GOOGLE_AGENT" && rm /tmp/install-google-agent.sh
