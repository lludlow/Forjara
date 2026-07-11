# Forjara — per-project AI coding workspaces on your tailnet

One container per project, each its own tailnet machine with web VS Code and
the AI coding CLIs ready in the terminal:

- `https://submind.<tailnet>.ts.net` → VS Code + Claude Code / Codex /
  Antigravity / opencode for project *submind*
- `https://atlas.<tailnet>.ts.net` → same for *atlas*

Valid HTTPS certs, tailnet-only, nothing published on the LAN.

## What's in the image

`ghcr.io/lludlow/forjara` = the official
[code-server release](https://github.com/coder/code-server/releases), on Node
22 slim, plus tmux, ripgrep, and:

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

Open `https://submind.<tailnet>.ts.net`. In the VS Code terminal:
`tmux new -A -s agents`, then `claude` / `codex` / `agy`.

## Adding a project

Copy a workspace block in `docker-compose.yml`, change the service name, the
`tsdproxy.name` label, and the two volume lines, then `docker compose up -d`.
[tsdproxy](https://github.com/almeidapaulopt/tsdproxy) picks it up from the
labels and it appears on your tailnet.

## Security notes

- Keep Tailscale Funnel off — these containers hold live Anthropic/OpenAI/
  Google credentials.
- Never mount `/var/run/docker.sock`, `~/.ssh`, `~/.aws`, or host `/home`
  into a workspace. (tsdproxy holds the socket; the workspaces never do.)
- Scope the auth key with a `tag:forjara` ACL.
- Running agents unsupervised? Add an egress firewall — see
  [Anthropic's devcontainer reference](https://code.claude.com/docs/en/devcontainer).

## Design

See [SPEC.md](SPEC.md) for the research, decisions, and rejected
alternatives (Kasm, webtop, Coder, tailscale sidecars).
