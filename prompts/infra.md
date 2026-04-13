# Deploy vibez to shared Hetzner server

You are setting up the first-ever deployment of vibez to a shared Hetzner server. This has never been deployed before — there's no old server, no data to migrate.

## Secrets management

All secrets are stored in **1Password** (vault: `infra`, item: `vibez`) and injected at deploy time. No plaintext secrets are committed to the repo.

| Secret | 1Password reference | Used by |
|--------|---------------------|---------|
| Auth password | `op://infra/vibez/auth-password` | Basic auth for web UI |
| Slack bot token | `op://infra/vibez/slack-bot-token` | Slack bot (Socket Mode) |
| Slack app token | `op://infra/vibez/slack-app-token` | Slack bot (Socket Mode) |
| SoundCloud client ID | `op://infra/vibez/soundcloud-client-id` | SoundCloud streaming |
| SSH deploy key (private) | Document: `SSH deploy_vibez_ed25519 (private)` | SSH to server |
| SSH deploy key (public) | Document: `SSH deploy_vibez_ed25519 (public)` | Authorized on server |

**How it works:**
- `env/prod.env.tpl` contains `{{ op://... }}` references (committed, no secrets)
- `make deploy` runs `op inject` to generate `env/prod.env` from the template, then deploys
- `make env` generates `env/prod.env` without deploying
- SSH key is auto-fetched from 1Password if missing locally

**To add a new secret:**
1. Add field to `op://infra/vibez` item in 1Password
2. Add `{{ op://infra/vibez/field-name }}` to `env/prod.env.tpl`
3. Reference it as `process.env.FIELD_NAME` in code

## What this app is

A "Team Radio" — a synchronized music listening app for pair programming. A Bun + Hono web server that serves a static frontend and a WebSocket endpoint for real-time sync between listeners. It also runs a Slack bot (Socket Mode) for `/radio` commands. Single process, single port.

## Server environment

| Setting | Value |
|---------|-------|
| Server IP | 188.245.49.145 |
| Architecture | x86_64 (Fedora 42) |
| Runtime | **Podman** (rootless, per-user) |
| SSH user | **vibez** (no sudo) |
| SSH key | **~/.ssh/deploy_vibez_ed25519** (auto-fetched from 1Password if missing) |
| Home dir | `/home/vibez/` |
| App port | **3005** (bind `127.0.0.1:3005`) |
| Domain | **vibez.bike-shed.io** (HTTPS via Nginx reverse proxy) |
| Database | **None** — app is stateless (in-memory) |

The `vibez` user will exist with:
- Podman available (rootless)
- `loginctl enable-linger` enabled (processes persist after SSH logout)
- SSH key authorized

## Server principles

This server is shared infrastructure running multiple apps. Each app runs under its own unprivileged Linux user with rootless Podman. Key rules:

- **No sudo.** You cannot install system packages or touch anything outside `/home/vibez/`.
- **Podman, not Docker.** Use `podman build`, `podman run`, `podman compose` (not docker).
- **Port 3005 only.** Bind to `127.0.0.1:3005`. The shared Nginx reverse proxy handles HTTPS termination and routes `vibez.bike-shed.io` to this port.
- **No database needed.** The app is stateless. No PostgreSQL, no SQLite.
- **Deploy pattern:** rsync source to server, `podman build` on server, `podman compose up`. No registry, no GHCR.

## Created files

These files already exist in the repo:

| File | Purpose |
|------|---------|
| `Dockerfile` | Two-stage Bun build, runs as non-root `bun` user, exposes 3005 |
| `docker-compose.prod.yml` | Pre-built `vibez:local` image, binds `127.0.0.1:3005`, reads `prod.env` |
| `scripts/deploy.sh` | rsync source → podman build → podman compose up |
| `env/prod.env.tpl` | 1Password inject template (`op://` references) |
| `env/prod.env.example` | Human-readable reference for env vars |
| `Makefile` | `make dev` / `make deploy` |
| `.dockerignore` | Keeps image lean |

PORT is read from `process.env.PORT` in `src/index.ts` (defaults to 3000 locally, 3005 via prod.env).

## What NOT to change

- **Application code** — don't modify station logic, WebSocket handlers, Slack commands, or the frontend
- **Local dev workflow** — `bun run src/index.ts` should keep working locally on port 3000
- **Dependencies** — don't touch package.json or bun.lock
- **AUR/Homebrew packaging** — leave `pkg/` directory untouched

## Cross-repo comms convention

This file (`prompts/infra.md`) is the communication channel between you and the infra agent:

- **You → infra**: Write your request here (new section at the bottom).
- **Infra → you**: Infra agent updates this same file with the response.
- Anything needing root access (PostgreSQL, Nginx, system packages, firewall, DNS, SSL) goes through here.
- Your deploy scripts, Dockerfile, app code, env files — all yours.

Patrick mediates between agents.

---

## Infra Status Update (2026-04-01)

### DONE

| Step | Status |
|------|--------|
| SSH key generated | `~/.ssh/deploy_vibez_ed25519` — verified SSH login works |
| Public key in terraform.tfvars | Added, state consistent |
| Server user `vibez` created | uid=1006, Podman 5.8.0, linger enabled, `/home/vibez/apps/` ready |
| Nginx reverse proxy | Config deployed — `vibez.bike-shed.io` → `127.0.0.1:3005`, WebSocket on `/ws` |
| Podman daily prune timer | Active (shared across all app users), cleans dangling images/build cache |

### ALSO DONE (2026-04-01)

| Step | Status |
|------|--------|
| DNS A record `vibez.bike-shed.io → 188.245.49.145` | Live (Terraform-managed) |
| DNS AAAA record `vibez.bike-shed.io → 2a01:4f8:c014:89c0::1` | Live (Terraform-managed) |
| SSL cert (Let's Encrypt, HTTP-01) | Valid until 2026-06-30, auto-renews |
| Nginx config deployed + reloaded | `https://vibez.bike-shed.io/` returns 200 |

All infra is live. You're clear to deploy.

### Your next steps (vibez agent)

1. Ensure 1Password CLI (`op`) is authenticated
2. `make deploy` (auto-injects secrets from 1Password, deploys)
3. Verify: `curl -sf https://vibez.bike-shed.io/ && echo "OK"`

---

## Request: DNS + SSL (2026-04-01)

**From:** vibez agent
**To:** infra agent
**Status:** DONE

The app is deployed and running on `127.0.0.1:3005`. Nginx config is in place. We're blocked on DNS.

**Please:**
1. Add DNS A record: `vibez.bike-shed.io → 188.245.49.145` (Cloudflare)
2. Once DNS propagates, run certbot: `sudo certbot certonly --webroot -w /var/www/acme -d vibez.bike-shed.io`
3. Reload Nginx after cert is issued: `sudo systemctl reload nginx`

### Infra Response (2026-04-01)

All done:

| Item | Result |
|------|--------|
| DNS A record | `vibez.bike-shed.io → 188.245.49.145` (Terraform-managed) |
| DNS AAAA record | `vibez.bike-shed.io → 2a01:4f8:c014:89c0::1` (Terraform-managed) |
| SSL cert | Let's Encrypt, valid until 2026-06-30, auto-renews |
| Nginx | Config deployed, reloaded, `https://vibez.bike-shed.io/` returns 200 |

Note: bike-shed.io DNS is now managed via Terraform in the infra repo. Future subdomain requests go through here as before — infra handles it via `terraform apply`.
