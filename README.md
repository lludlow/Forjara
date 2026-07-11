# Forjara — multi-agent coding workspaces on your tailnet

One container per workspace, each its own tailnet machine with a custom
libghostty-powered agent interface, optional web VS Code, and the AI coding
CLIs ready to run:

- `https://submind.<tailnet>.ts.net` → VS Code for *submind*
- `https://submind.<tailnet>.ts.net:8444` → Forjara agent workspace

Valid HTTPS certs, tailnet-only, nothing published on the LAN.

The Forjara interface discovers projects, creates persistent tmux sessions,
optionally creates Git worktrees, launches agents, and keeps multiple terminals
open in tabs or a split. Terminal parsing, screen state, and keyboard encoding
come from an official pinned `libghostty-vt.wasm` build; the server, renderer,
and workspace UI are Forjara code.

## What's in the image

`ghcr.io/lludlow/forjara` contains the Forjara web service, the official
[code-server release](https://github.com/coder/code-server/releases), tmux,
ripgrep, and:

| CLI | command |
|---|---|
| Claude Code | `claude` |
| OpenAI Codex | `codex` |
| Google Antigravity | `agy` (build with `GOOGLE_AGENT=gemini` for enterprise Gemini CLI) |
| opencode | `opencode` |

CLI logins persist in each project's `/config` volume — log in once per
project, survives container recreation.

## Quick start

Prereqs (one-time): [MagicDNS + HTTPS certs](https://tailscale.com/kb/1153/enabling-https)
enabled on your tailnet; a reusable auth key tagged `tag:forjara`.

```bash
git clone git@github.com:lludlow/Forjara.git && cd Forjara
cp config/tsdproxy.yaml.example config/tsdproxy.yaml   # paste your auth key
docker compose up -d
```

Open `https://submind.<tailnet>.ts.net:8444`, choose **New agent**, then select
the project, agent, and whether it should get an isolated Git worktree.

VS Code remains available at `https://submind.<tailnet>.ts.net`.

## Interface modes

Both interfaces are enabled by default. Set one environment variable before
starting Compose to run only one:

```bash
FORJARA_SERVICES=vscode docker compose up -d
FORJARA_SERVICES=web docker compose up -d
```

The disabled interface's port is unavailable. The supported values are
`vscode`, `web`, or `vscode,web`.

## Adding a project

Copy a workspace block in `docker-compose.yml`, change the service name, the
`tsdproxy.name` label, and the two volume lines, then `docker compose up -d`.
[tsdproxy](https://github.com/almeidapaulopt/tsdproxy) picks it up from the
labels and it appears on your tailnet.

## One or many projects per container

The default Compose example mounts one project at `/workspace`. To use a
container as a projects hub instead, mount the directory containing them:

```yaml
volumes:
  - workspace-config:/config
  - ${HOME}/projects:/workspace
```

When `/workspace` is a Git repository, Forjara treats it as one project. When
it is a directory of projects, immediate child directories appear separately;
plain folders work too.

Worktrees live under `<project>/.forjara/worktrees/` and are excluded through
the repository's local `.git/info/exclude`. Closing a session does not delete
its worktree.

## Agent attention signals

Agent sessions receive `FORJARA_SESSION_ID` and `FORJARA_EVENT_SOCKET`.
Integrations can update the sidebar without parsing terminal output:

```bash
forjara-web signal busy
forjara-web signal awaiting_input
forjara-web signal idle
forjara-web signal notification
```

Forjara reports agent process start and exit automatically. Agent-specific
hooks may invoke the commands above; they are delivered over a private Unix
socket and streamed to open browsers.

## Security notes

- Keep Tailscale Funnel off — these containers hold live Anthropic/OpenAI/
  Google credentials.
- Never mount `/var/run/docker.sock`, `~/.ssh`, `~/.aws`, or host `/home`
  into a workspace. (tsdproxy holds the socket; the workspaces never do.)
- Scope the auth key with a `tag:forjara` ACL.
- Running agents unsupervised? Add an egress firewall — see
  [Anthropic's devcontainer reference](https://code.claude.com/docs/en/devcontainer).

## Design

See [WEB_TERMINAL_DESIGN.md](WEB_TERMINAL_DESIGN.md) for the architecture,
libghostty boundary, delivery plan, and deferred features.
