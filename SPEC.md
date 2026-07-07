# aidev — AI coding workspace in a box

One workspace container **per project**, each its own tailnet machine:
`https://submind.<tailnet>.ts.net`, `https://atlas.<tailnet>.ts.net`, ...
Each is web VS Code + Claude Code / Codex / Antigravity / opencode in tmux,
valid certs, tailnet-only. Nothing published on the LAN.

## Why this exists

Nothing ships this combo (verified July 2026): HolyClaude/codeg bundle the
CLIs but not VS Code; joostme/opencode-docker has code-server but one agent;
Kasm's official `kasmweb/claude-code` etc. are one-CLI-per-container pixel
streams; nobody bundles Tailscale. Coder does it all but is a platform, not
an image.

## Stack decisions

| Choice | Pick | Rejected |
|---|---|---|
| IDE | code-server (lsio image base) | webtop/Kasm — pixel stream, heavier; binhex — fine but nonstandard base, no tooling anyway |
| Terminals | tmux inside code-server's integrated terminal | ttyd (tsdproxy is one-port-per-container; add back if a dedicated phone terminal is missed), wetty (needs sshd), sshx (relays via sshx.io) |
| Remote access | tsdproxy (one daemon, per-container tailnet hostname via labels) | N tailscale sidecars — 2 containers + state dir per project; host tailscale — one hostname only; reverse-proxy+certbot — why |
| CLIs | baked into image via `npm i -g` | DOCKER_MODS install-at-boot — slow, non-persistent |

## Layout

```
aidev/
├── docker-compose.yml        # tsdproxy + one service block per project
├── Dockerfile
├── install-google-agent.sh
├── config/tsdproxy.yaml      # holds the tailscale auth key
└── README.md
```

## Dockerfile

```dockerfile
FROM lscr.io/linuxserver/code-server:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux ripgrep jq less openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Node 22 + the agent CLIs
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs \
 && npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
 && rm -rf /var/lib/apt/lists/*

# Google agent is pluggable: Gemini CLI stopped serving free/AI Pro/Ultra
# users 2026-06-18; consumers get Antigravity CLI, enterprise/API-key
# accounts keep Gemini CLI.
ARG GOOGLE_AGENT=antigravity   # antigravity | gemini | none
COPY install-google-agent.sh /tmp/
RUN /tmp/install-google-agent.sh "$GOOGLE_AGENT"
```

Notes:
- lsio base gives PUID/PGID, s6 services, `/config` persistence for free.
- CLI auth state (`~/.claude`, `~/.codex`, `~/.gemini`) lives under `/config`
  (abc's home), so logins survive container recreation. Log in once via the
  code-server terminal; OAuth device-code flows work fine headless.
- `xbuild` (or whatever else): add to the npm/apt line.

## docker-compose.yml

tsdproxy (https://github.com/almeidapaulopt/tsdproxy) watches the Docker
socket; any container labeled `tsdproxy.enable` becomes its own tsnet-based
tailnet machine with automatic HTTPS. One daemon for all projects — adding a
project is a copy-pasted service block (or a compose YAML anchor).

```yaml
x-workspace: &workspace
  build: .
  restart: unless-stopped
  environment: &workspace-env
    PUID: "1000"
    PGID: "1000"
    TZ: America/Detroit
    DEFAULT_WORKSPACE: /workspace
    # auth handled by tailnet — leave lsio PASSWORD/HASHED_PASSWORD unset

services:
  tsdproxy:
    image: almeidapaulopt/tsdproxy:2
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - tsdproxy-data:/data
      - ./config:/config            # tsdproxy.yaml holds the auth key
    restart: unless-stopped

  submind:
    <<: *workspace
    labels:
      tsdproxy.enable: "true"
      tsdproxy.name: "submind"      # -> https://submind.<tailnet>.ts.net
      tsdproxy.container_port: "8443"
    volumes:
      - submind-config:/config
      - /srv/projects/submind:/workspace

  atlas:
    <<: *workspace
    labels:
      tsdproxy.enable: "true"
      tsdproxy.name: "atlas"        # -> https://atlas.<tailnet>.ts.net
      tsdproxy.container_port: "8443"
    volumes:
      - atlas-config:/config
      - /srv/projects/atlas:/workspace

volumes:
  tsdproxy-data:
  submind-config:
  atlas-config:
```

No ports published on the LAN; workspaces are reachable only via their
tailnet hostnames. Funnel stays off — these boxes hold live
Anthropic/OpenAI/Google credentials.

Per-workspace CLI auth: each project has its own `/config` volume, so you
log into claude/codex once per project and it persists across recreates.
(Sharing one auth volume across containers invites concurrent-write
weirdness in `~/.claude`; logins are cheap, keep them separate.)

ttyd note: tsdproxy proxies one port per container, so `/term/` path routing
from the sidecar design goes away. The VS Code integrated terminal (running
`tmux new -A -s agents`) covers 95% of it. If you want a dedicated phone
terminal, check tsdproxy v2 multi-port labels for a `submind-term` hostname;
otherwise skip ttyd entirely. # ponytail: cut until missed

## Usage

```bash
# config/tsdproxy.yaml: paste a reusable, tagged tailscale auth key
docker compose up -d --build
# https://submind.<tailnet>.ts.net   VS Code + terminal for project submind
# https://atlas.<tailnet>.ts.net     same for atlas
```

New project = new service block (3 lines differ: name, label, mounts) +
`docker compose up -d`.

## Tailscale: why tsdproxy over the alternatives

- **N official sidecars** (`network_mode: service:tailscale` + serve.json
  each): fully supported by Tailscale, but 2 containers + a state volume +
  a serve config per project. Correct fallback if tsdproxy ever bit-rots —
  pattern documented at https://tailscale.com/kb/1282/docker.
- **Host tailscale + `tailscale serve`**: one hostname per host — can't do
  `submind.` / `atlas.` per-project names. Out.
- **tsdproxy trade-off**: a third-party daemon holding your auth key AND the
  Docker socket. Acceptable because it's the infra daemon, not the AI
  workspaces — the agents still never see the socket. Use a tagged key
  (`tag:aidev`) so its blast radius is ACL-bounded.

Do NOT do the hybrid where a tailscale sidecar runs beside an app container
publishing to host 127.0.0.1 without `network_mode: service:tailscale` and a
serve config — the sidecar joins the tailnet but routes nothing to the app.

## Security defaults

- Never mount `/var/run/docker.sock`, `~/.ssh`, `~/.aws`, `~/.kube`, or host
  `/home` into the workspace — an agent with the docker socket is host-root,
  and Anthropic's own devcontainer docs call out credential exfiltration
  from malicious repos.
- Nested builds, in order of preference: rootless podman > sysbox >
  privileged dind (trusted repos on a disposable host only). v1 ships none.
- Funnel off; tailnet ACLs limit who reaches `tag:aidev`.
- Egress firewall: crib `init-firewall.sh` from Anthropic's devcontainer
  when running agents unsupervised.

## Graduation path: Coder OSS

Coder (coder.com) is the right orchestrator when this outgrows one box:
per-project workspaces from Terraform templates, devcontainer.json support
via @devcontainers/cli, idle shutdown, built-in code-server + web terminal,
WireGuard networking. The workspace **image** built here carries over
unchanged as a Coder template's image — so nothing in v1 is throwaway.
Move when you actually hit the pain: >2-3 concurrent project workspaces,
per-repo devcontainer rebuilds, or other users. Not before: Coder adds a
control plane + Postgres + Terraform for capabilities n=1 doesn't use.

## v1 scope cuts (add when actually missed)

- No egress firewall (Anthropic's devcontainer has `init-firewall.sh` to
  crib if you start running agents unsupervised)
- No full desktop — if a CLI truly needs an in-container browser, that's the
  day to build a `FROM linuxserver/webtop:ubuntu-xfce` variant, not today
- No multi-user, no Kasm, no Coder
- Mobile Claude Code control: Happy (happy.engineering) wraps `claude` and
  mirrors it E2EE to your phone — drop-in later, nothing to design for

## Tailnet prereqs (one-time)

MagicDNS + HTTPS certs enabled on the tailnet; auth key (reusable, tagged
`tag:aidev`) from the admin console.

## References

- Tailscale sidecar + serve: https://tailscale.com/kb/1282/docker,
  https://github.com/tailscale-dev/docker-guide-code-examples
- lsio code-server: https://docs.linuxserver.io/images/docker-code-server/
- Anthropic devcontainer (firewall reference): https://code.claude.com/docs/en/devcontainer
- Prior art: https://github.com/CoderLuii/HolyClaude,
  https://github.com/xintaofei/codeg,
  https://github.com/joostme/opencode-docker,
  https://github.com/itscooleric/clide
