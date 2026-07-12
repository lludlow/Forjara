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

The sidebar lists **workspaces** — each project checkout plus one entry per
worktree — with the agents running inside and an attention dot. The tab bar
holds the terminals of the selected workspace: `+` (or `⌘K`) opens a new agent
there, `✕` stops one, and Split shows two side by side. Closing a workspace
stops its tabs and offers to remove its worktree; Git refuses to remove dirty
worktrees, and branches are always kept.

![Split view of two live terminals with workspaces and tabs](docs/images/45c1cee0-2026-07-12.png)

Above: the `main` workspace with two terminal tabs split side by side, and a
`forjara/fix-api-tests` worktree workspace ready in the sidebar. Every session
keeps running in tmux whether or not a browser is attached.

## What's in the image

`ghcr.io/lludlow/forjara` contains the Forjara web service, the official
[code-server release](https://github.com/coder/code-server/releases), tmux,
ripgrep, [mise](https://mise.jdx.dev) for per-project language runtimes, and:

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

Open `https://submind.<tailnet>.ts.net:8444`, press **+** (or `⌘K`), then pick
the project, agent, and whether it should get an isolated Git worktree.

![New agent dialog creating a session on a new Git worktree](docs/images/c88db4a7-2026-07-12.png)

VS Code remains available at `https://submind.<tailnet>.ts.net`.

## Local QA

Copy the example compose file (the copy is gitignored — point its mounts at
whatever you want to test), then build and run:

```bash
cp docker-compose.local.example.yml docker-compose.local.yml
docker compose -f docker-compose.local.yml up --build -d
```

Open Forjara at `http://localhost:8080` or VS Code at
`http://localhost:8443`. Stop it with:

```bash
docker compose -f docker-compose.local.yml down
```

The config volume survives rebuilds. Add `-v` to `down` when you want a clean
login and session state.

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
the repository's local `.git/info/exclude`. Closing a tab never deletes a
worktree; closing a workspace asks first, runs `git worktree remove` without
`--force` so uncommitted work survives, and never deletes the branch.

## Project environments

The base image stays small on purpose — projects bring their own toolchains.
The repository owns its environment; Forjara owns the development experience.

### Language runtimes via mise

[mise](https://mise.jdx.dev) is preinstalled. A project that carries a
`mise.toml` declares what it needs:

```toml
[tools]
go = "1.22"
python = "3.12"
```

Run `mise trust && mise install` once in a terminal tab and the runtimes are
live — installed under `/config`, so they survive container recreation and are
shared by every project in the container. corepack is enabled too, so a
`packageManager` pin in package.json (pnpm, yarn) resolves on first use.

### OS packages: derive a project image

mise covers language runtimes, not native libraries, database clients, or
browser-test dependencies. For those, the project supplies a small Dockerfile
(e.g. `.forjara/Dockerfile`) on top of the base image:

```dockerfile
FROM ghcr.io/lludlow/forjara:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client libvips-dev \
 && rm -rf /var/lib/apt/lists/*
USER node
```

and its workspace block in `docker-compose.yml` adds a `build:` section with
a project-specific `image:` tag and `pull_policy: build` (see the commented
example there). It's a thin layer on the already-pulled base image, so the
build takes seconds. Everything else — entrypoint, agents, code-server,
`/config` persistence — is inherited.

### Service sidecars

Projects that need PostgreSQL, Redis, or similar get them as extra Compose
services next to their workspace block, reachable by service name on the
shared network. The workspace never gets the Docker socket; the host manages
the sidecars. See the commented `atlas-db` example in `docker-compose.yml`.

### Running and previewing a web app

Start the dev server in any terminal tab — tmux keeps it running when the
browser disconnects. With the `vscode` service enabled, code-server proxies
any local port over the existing tailnet hostname:

```text
https://atlas.<tailnet>.ts.net/proxy/5173/
```

Apps that can't tolerate the path prefix can use `/absproxy/<port>/` instead —
see the [code-server proxy docs](https://github.com/coder/code-server/blob/main/docs/guide.md#accessing-web-services).

Tests are the project's own commands — `go test ./...`, `pnpm test`, `pytest`
— run in a tab like anything else. Forjara deliberately has no test-harness
abstraction or language detection.

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
