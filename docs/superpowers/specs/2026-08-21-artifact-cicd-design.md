# Artifact-based CI/CD for B.O.T + fresh-server provisioning

**Date:** 2026-08-21
**Status:** Approved design, pending implementation plan
**Repo:** `sayembillah-dev/B.O.T` (public, default branch `main`)
**Target host:** `192.168.1.219` (`play`)

## 1. Problem

The repo has no CI and no deployment path. The target server is bare. We want a
pipeline that builds the app **once**, publishes that build as an artifact, and
deploys those exact bytes to the server — no `git pull`, no `npm install`, and
no `next build` on the target host.

## 2. Facts that constrain the design

Established by inspection, not assumed.

**Application** (`B.O.T/`)

- Next.js 16.3.1 + React 19.2.8, custom server `server.js` (Next + Socket.IO
  4.8.3 in a single process), launched in prod via `start.mjs` (`npm start`).
- Room state is `const rooms = new Map()` — **in-process, in-memory**.
- All five dependencies are `dependencies`; there are **no `devDependencies`**.
- `server.js` binds `process.env.HOST || '0.0.0.0'` on `process.env.PORT || 3000`.
- `.gitignore` ignores `.env*` — runtime config is not in the repo, by design.
- `scripts/smoke-test.mjs` (`npm run smoke`) is a **client-side** test: it dials
  `URL` with socket.io-client, joins room `smoke42` with two clients, starts and
  ends a game, and asserts a 9th player is rejected. It binds no port, so it is
  safe to run against a live server.
- Both `package-lock.json` and `pnpm-lock.yaml` are committed.
- `package.json` declares `"next" | "react" | "react-dom": "latest"`.

**Server** (`nifty@192.168.1.219`)

- Debian GNU/Linux 13 (trixie), `x86_64`, glibc 2.41.
- LXC container on Proxmox (kernel `7.0.14-12-pve`); systemd is running.
- 2 vCPU, 4.0 GiB RAM, 16 GB root disk (713 MB used).
- Installed: `tar` only. **No** node, npm, git, nginx, or curl.
- `nifty` is in group `sudo` with `(ALL : ALL) ALL`; password auth is enabled.

**Consequences**

- `x86_64` + glibc means a GitHub `ubuntu-latest` runner is a matching build
  host: the `@next/swc-linux-x64-gnu` binary baked into `node_modules` will run.
  An ARM or musl target would have invalidated this whole approach.
- In-memory room state forces **exactly one process**. No PM2 cluster mode, no
  replicas, no horizontal scaling — they silently break room routing.
- Therefore **every deploy ends every in-flight game**. Zero-downtime deployment
  is unachievable here and blue/green buys nothing. Atomic symlink swap plus a
  fast restart is the correct ceiling.

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| CI→server transport | Self-hosted GitHub Actions runner on `.219` | `192.168.1.219` is RFC1918; GitHub-hosted runners cannot reach it. A runner dials out, so no inbound firewall hole and no tunnel dependency. |
| Artifact format | `.tar.gz` of the built tree, incl. `node_modules` | No `devDependencies` means no prune step; the server never builds or installs. |
| Process supervision | systemd | Already present; no extra runtime to install. PM2 would add a dependency and a footgun (cluster mode). |
| Ingress | nginx reverse proxy on :80 | Keeps node on loopback and centralises the WebSocket upgrade config. |
| Repo visibility | Stays public | User's call; mitigations in §7. |
| TLS | Out of scope | LAN-only HTTP. |

## 4. Pipeline

`.github/workflows/ci-cd.yml`, three jobs.

### `build` — `ubuntu-latest`

1. `actions/checkout`
2. `actions/setup-node` (Node 22 LTS, `cache: npm`)
3. `npm ci`
4. `npm run build`
5. `tar czf bot-game-${GITHUB_SHA}.tar.gz` of the worktree, excluding `.git`,
   `.github`, `docs`, `pnpm-lock.yaml`
6. `actions/upload-artifact` (retention 14 days)

Tarring before upload is deliberate: `upload-artifact` over a loose
`node_modules` tree is pathologically slow.

### `verify` — `ubuntu-latest`, needs `build`

Downloads **the artifact** (not the source), untars it, boots it with
`PORT=3000 npm start`, waits for a Socket.IO handshake, runs `npm run smoke`
against it, tears down. This exercises the exact bytes that will be deployed.

### `deploy` — `self-hosted`, needs `build` + `verify`

Guarded by `if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'`
and bound to the `production` GitHub Environment.

1. `actions/checkout` — the deploy job needs `deploy/deploy.sh` *before* it can
   untar anything, so it checks out the repo for the script and takes the
   application bytes only from the artifact.
2. `actions/download-artifact`
3. `deploy/deploy.sh <tarball> <sha>`:
   - untar into `/srv/bot-game/releases/<sha>/`
   - record the current symlink target as the rollback point
   - `ln -sfn` into a temp name, then `mv -T` over `current` (atomic swap)
   - `sudo systemctl restart bot-game`
   - **health gate**: poll `http://127.0.0.1/socket.io/?EIO=4&transport=polling`
     through nginx for a valid Engine.IO handshake (`0{"sid":...`), 30s budget
   - run `npm run smoke` from the release dir against `http://127.0.0.1`
   - on any failure: repoint the symlink to the rollback point, restart, exit 1
   - on success: prune all but the 5 most recent releases

The health gate deliberately does **not** accept a 200 on `/`. A misconfigured
proxy still serves HTML fine while Socket.IO is broken; the handshake is the
thing that actually breaks.

### Triggers

- `pull_request` → `build` + `verify` only. Never touches the self-hosted runner.
- `push` to `main`, `workflow_dispatch` → all three jobs.

## 5. Server layout

```
/srv/bot-game/
├── releases/<sha>/          # untarred artifacts, 5 retained
└── current -> releases/<sha>
/etc/bot-game/env            # runtime config, OUTSIDE releases
/home/deploy/actions-runner/ # GitHub Actions runner
```

`/etc/bot-game/env` lives outside `releases/` on purpose: inside, the next
deploy would orphan it.

```
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
```

`HOST=127.0.0.1` overrides `server.js`'s `0.0.0.0` default so node is
unreachable except through nginx.

### Users

- `deploy` — owns `/srv/bot-game`, runs the Actions runner. Not the app user.
- `botgame` — `nologin` system account; the systemd unit's `User=`. Owns nothing.

Separating them means a compromised runner job cannot alter a running service
except through the one sudoers rule below, and the service cannot rewrite its
own code.

### systemd — `/etc/systemd/system/bot-game.service`

`Restart=always`, `RestartSec=2`, `EnvironmentFile=/etc/bot-game/env`,
`WorkingDirectory=/srv/bot-game/current`, `ExecStart=/usr/bin/node start.mjs`,
`User=botgame`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=full`.
Logs go to journald. `WorkingDirectory` resolves the symlink at start, so a
restart is what picks up a new release.

### nginx — `/etc/nginx/sites-available/bot-game`

`proxy_pass http://127.0.0.1:3000` with `proxy_http_version 1.1`,
`Upgrade`/`Connection "upgrade"`, `Host`/`X-Forwarded-For`/`X-Forwarded-Proto`,
and `proxy_read_timeout 3600s`. Without the upgrade headers Socket.IO silently
degrades to long-polling and produces intermittent disconnects.

### Firewall

`ufw`: allow 22 and 80, deny everything else inbound. Port 3000 is already
loopback-only via `HOST`.

## 6. Provisioning runbook (`docs/DEPLOYMENT.md`)

Ordered, idempotent, copy-pasteable:

1. `apt update && apt install -y curl ca-certificates gnupg nginx ufw`
2. Node 22 LTS from NodeSource (must match the CI `setup-node` major)
3. `useradd` for `deploy` and `botgame`; create `/srv/bot-game/releases`
4. `/etc/bot-game/env`
5. systemd unit + `daemon-reload`
6. nginx site + `nginx -t` + enable
7. sudoers drop-in (§7)
8. Install and register the Actions runner as a systemd service under `deploy`
9. ufw
10. SSH hardening: disable password auth once key auth is confirmed
11. First deploy via `workflow_dispatch`; verify with the §4 health gate

## 7. Security model

A self-hosted runner on a **public** repo is the main risk: by default, a fork
PR can execute attacker-controlled code on the box. Mitigations, all of which
must hold together:

1. **Primary control.** In repo settings, **"Require approval for all external
   contributors"** must be set for workflow runs from forks. This is not
   defence-in-depth — it is the control. For a `pull_request` event GitHub takes
   the workflow definition from the *fork's* branch, so a fork can author its own
   job with `runs-on: [self-hosted, bot-game]`, and no `if:` condition in *our*
   workflow constrains a job we did not write. **Do not register the runner until
   this setting is applied.** (Corrected 2026-08-21 after review; an earlier
   revision of this section wrongly listed the `deploy` job's `if:` guard as the
   primary control.)
2. The `deploy` job never runs on `pull_request` — only `push` to `main` (which
   requires write access) and manual `workflow_dispatch`. This protects the
   deploy path specifically; it cannot protect against a fork-authored job.
3. `deploy` is bound to a `production` GitHub Environment, which can require a
   reviewer and can be restricted to `main`.
4. The runner runs as unprivileged `deploy`, not root.
5. Sudoers is a narrow drop-in, not blanket NOPASSWD:
   `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart bot-game, /usr/bin/systemctl start bot-game, /usr/bin/systemctl stop bot-game, /usr/bin/systemctl is-active bot-game`
   (sudoers matches the literal path; on Debian 13 `systemctl` is
   `/usr/bin/systemctl`, and `/bin` is only a symlink.)

No SSH key is stored in GitHub secrets under this model — the runner
authenticates outbound with its own registration token.

**Credential hygiene (separate from the pipeline):** the ed25519 key pasted into
chat is disclosed and should be rotated; `nifty`/`nifty` is a guessable password
pair, and password auth should be disabled once key auth is verified.

## 8. Repo changes

1. Pin `next@16.3.1`, `react@19.2.8`, `react-dom@19.2.8` in `package.json`.
   `npm ci` already pins from the lockfile, but `"latest"` means the next
   `npm install` anyone runs silently changes majors under the pipeline.
2. Delete `pnpm-lock.yaml`; standardise on npm so CI and local agree.
3. Add `.github/workflows/ci-cd.yml`.
4. Add `deploy/bot-game.service`, `deploy/nginx-bot-game.conf`, `deploy/deploy.sh`.
5. Add `docs/DEPLOYMENT.md`.

## 9. Out of scope

TLS/HTTPS; multi-environment (staging); horizontal scaling or a Redis-backed
Socket.IO adapter; log shipping; Dependabot/lint/type-check jobs; monitoring.

## 10. Success criteria

- A push to `main` produces a deployed, healthy service without any human
  touching the server.
- The server never runs `npm install`, `next build`, or `git`.
- A deliberately broken build fails at `verify` and never reaches the server.
- A deploy that starts but fails its health gate rolls back automatically and
  reports failure in the Actions UI.
- Rollback to any of the last 5 releases takes two commands and no rebuild.
- `curl 'http://192.168.1.219/socket.io/?EIO=4&transport=polling'` returns a
  valid Engine.IO handshake, and two browsers on the LAN can play a game.
