# Artifact-based CI/CD + Server Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the app once in GitHub Actions, publish it as a tarball artifact, and deploy those exact bytes to `192.168.1.219` via a self-hosted runner, with an automatic health gate and rollback.

**Architecture:** Three jobs — `build` and `verify` on `ubuntu-latest`, `deploy` on a self-hosted runner inside the LAN. The artifact contains the built tree *including* `node_modules`, so the server never runs `npm install`, `next build`, or `git`. On the server, releases untar into `/srv/bot-game/releases/<sha>` and an atomic symlink swap plus `systemctl restart` activates them. A failed post-restart health check repoints the symlink and exits non-zero.

**Tech Stack:** Next.js 16.3.1, React 19.2.8, Socket.IO 4.8.3, Node 22 LTS, Debian 13 (trixie), systemd, nginx, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-21-artifact-cicd-design.md`

## Global Constraints

- Node major **22** on both the CI runner and the server. They must match — the artifact ships prebuilt binaries.
- Server is `x86_64` + glibc 2.41 → build host must be `ubuntu-latest` (x64, glibc). Never `-arm64` or `-musl`.
- **Exactly one app process.** Room state is an in-memory `Map`. No PM2 cluster, no replicas.
- The server must never execute `npm install`, `npm ci`, `next build`, or `git` as part of a deploy.
- The `deploy` job must never run on `pull_request` — the repo is public and the runner is self-hosted.
- Sudoers paths must be literal `/usr/bin/systemctl` (Debian 13 `/bin` is a symlink).
- Runtime config lives at `/etc/bot-game/env`, outside `releases/`.
- `HOST=127.0.0.1` in the env file — node stays on loopback behind nginx.
- Health means a valid Engine.IO handshake (response starts with `0{"sid":`), never a 200 on `/`.

---

### Task 1: Make the build deterministic

**Files:**
- Modify: `package.json` (dependency ranges)
- Delete: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: nothing.
- Produces: a `package.json` whose dependency versions match `package-lock.json` exactly, and a single lockfile (`package-lock.json`).

- [ ] **Step 1: Confirm the versions the lockfile currently resolves**

```bash
node -e "const l=require('./package-lock.json');for(const k of ['next','react','react-dom','socket.io','socket.io-client'])console.log(k, l.packages['node_modules/'+k].version)"
```

Expected: `next 16.3.1`, `react 19.2.8`, `react-dom 19.2.8`, `socket.io 4.8.3`, `socket.io-client 4.8.3`.

- [ ] **Step 2: Pin the three `latest` ranges**

In `package.json`, replace:

```json
    "next": "latest",
    "react": "latest",
    "react-dom": "latest",
```

with:

```json
    "next": "16.3.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
```

- [ ] **Step 3: Delete the second lockfile**

```bash
rm pnpm-lock.yaml
```

- [ ] **Step 4: Prove `npm ci` still succeeds against the unchanged lockfile**

```bash
npm ci
```

Expected: installs without rewriting `package-lock.json`. Verify with `git diff --stat package-lock.json` → no output. If npm *does* rewrite it, the pins disagree with the lockfile; fix the pins to match, never the other way.

- [ ] **Step 5: Prove the build works**

```bash
npm run build
```

Expected: `.next/` produced, exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json && git rm --cached pnpm-lock.yaml
git commit -m "build: pin next/react versions and standardise on npm lockfile"
```

---

### Task 2: Add the deploy assets to the repo

**Files:**
- Create: `deploy/bot-game.service`
- Create: `deploy/nginx-bot-game.conf`
- Create: `deploy/deploy.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `deploy/deploy.sh <tarball> <sha>` — run by the `deploy` job as user `deploy`; exit 0 = healthy release live, exit 1 = rolled back. Unit name `bot-game.service`. App root `/srv/bot-game`.

- [ ] **Step 1: Write the systemd unit**

`deploy/bot-game.service`:

```ini
[Unit]
Description=B.O.T - battle of tanks (Next.js + Socket.IO)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=botgame
Group=botgame
WorkingDirectory=/srv/bot-game/current
EnvironmentFile=/etc/bot-game/env
ExecStart=/usr/bin/node start.mjs
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bot-game
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` resolves the symlink at start, so `restart` is what picks up a new release. `ProtectSystem=full` leaves `/srv` writable, which Next needs for `.next/cache`.

- [ ] **Step 2: Write the nginx site**

`deploy/nginx-bot-game.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

The `map` block plus `Upgrade`/`Connection` headers are what keep Socket.IO on WebSockets. Without them it silently falls back to long-polling and players see random disconnects. `listen ... default_server` collides with Debian's stock site — Task 3 removes that.

- [ ] **Step 3: Write the deploy script**

`deploy/deploy.sh`:

```bash
#!/usr/bin/env bash
# Activate a build artifact as the live release. Run on the target host as the
# `deploy` user. Never builds, installs, or clones anything.
set -euo pipefail

TARBALL="${1:?usage: deploy.sh <tarball> <sha>}"
SHA="${2:?usage: deploy.sh <tarball> <sha>}"

APP_ROOT=/srv/bot-game
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
HEALTH_URL='http://127.0.0.1/socket.io/?EIO=4&transport=polling'
KEEP=5

log() { printf '\n▸ %s\n' "$*"; }

# A 200 on / proves nothing: a broken proxy still serves HTML while websockets
# are dead. Only an Engine.IO handshake (a body starting with `0{"sid":`) counts.
health() {
    local i body
    for i in $(seq 1 30); do
        body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
        case "$body" in
            0\{\"sid\"*) return 0 ;;
        esac
        sleep 1
    done
    return 1
}

activate() {
    ln -sfn "$1" "$APP_ROOT/current.tmp"
    mv -Tf "$APP_ROOT/current.tmp" "$CURRENT"
    sudo /usr/bin/systemctl restart bot-game
}

PREVIOUS=""
[ -L "$CURRENT" ] && PREVIOUS="$(readlink -f "$CURRENT")"

NEW="$RELEASES/$SHA"
log "Unpacking $(basename "$TARBALL") -> $NEW"
rm -rf "$NEW"
mkdir -p "$NEW"
tar xzf "$TARBALL" -C "$NEW"
[ -f "$NEW/start.mjs" ] || { echo "artifact missing start.mjs"; exit 1; }
[ -d "$NEW/.next" ]     || { echo "artifact missing .next build output"; exit 1; }

log "Activating $SHA"
activate "$NEW"

rollback() {
    log "FAILED: $1"
    if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
        log "Rolling back to $(basename "$PREVIOUS")"
        activate "$PREVIOUS"
        health && log "Rollback healthy" || log "Rollback is ALSO unhealthy - manual intervention needed"
    else
        log "No previous release to roll back to"
    fi
    exit 1
}

health || rollback "health check (no Engine.IO handshake within 30s)"
log "Health check passed"

log "Running smoke test against the live service"
( cd "$NEW" && URL=http://127.0.0.1 node scripts/smoke-test.mjs ) || rollback "smoke test"

log "Pruning old releases (keeping $KEEP)"
LIVE="$(readlink -f "$CURRENT")"
# shellcheck disable=SC2012
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    [ "$(readlink -f "$old")" = "$LIVE" ] && continue
    rm -rf "$old"
done

log "Deployed $SHA"
```

- [ ] **Step 4: Verify the script parses and is executable**

```bash
chmod +x deploy/deploy.sh
bash -n deploy/deploy.sh && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 5: Commit**

```bash
git add deploy/
git commit -m "deploy: add systemd unit, nginx site and release activation script"
```

---

### Task 3: Provision the server base

**Files:**
- Server: `/etc/bot-game/env`, `/etc/systemd/system/bot-game.service`, `/etc/nginx/sites-available/bot-game`, `/etc/sudoers.d/bot-game-deploy`, `/srv/bot-game/releases/`

**Interfaces:**
- Consumes: `deploy/bot-game.service`, `deploy/nginx-bot-game.conf` from Task 2.
- Produces: users `deploy` and `botgame`; a `bot-game.service` unit that is enabled but *inactive* (no release exists yet); nginx listening on :80; `sudo -n /usr/bin/systemctl restart bot-game` working for `deploy`.

All commands run over SSH as `nifty` (in group `sudo`).

- [ ] **Step 1: Install base packages**

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg nginx ufw
```

Expected: the box has none of these yet except `tar`.

- [ ] **Step 2: Install Node 22 from NodeSource**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

Expected: `v22.x`. Must match the CI `NODE_VERSION`.

- [ ] **Step 3: Create users and the release tree**

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin botgame
sudo useradd --create-home --shell /bin/bash deploy
sudo mkdir -p /srv/bot-game/releases
sudo chown -R deploy:deploy /srv/bot-game
sudo chmod 755 /srv/bot-game /srv/bot-game/releases
```

`deploy` writes releases; `botgame` only reads and runs them.

- [ ] **Step 4: Write the runtime env file**

```bash
sudo mkdir -p /etc/bot-game
printf 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\n' | sudo tee /etc/bot-game/env
sudo chmod 640 /etc/bot-game/env
sudo chown root:botgame /etc/bot-game/env
```

- [ ] **Step 5: Install the systemd unit**

```bash
sudo cp deploy/bot-game.service /etc/systemd/system/bot-game.service
sudo systemctl daemon-reload
sudo systemctl enable bot-game
```

Do **not** start it — `/srv/bot-game/current` does not exist until the first deploy.

- [ ] **Step 6: Install the nginx site**

```bash
sudo cp deploy/nginx-bot-game.conf /etc/nginx/sites-available/bot-game
sudo ln -sfn /etc/nginx/sites-available/bot-game /etc/nginx/sites-enabled/bot-game
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Expected: `nginx -t` reports `syntax is ok` / `test is successful`. Removing the stock `default` site is required — two `default_server` blocks on :80 is a fatal config error.

- [ ] **Step 7: Grant the narrow sudoers rule**

```bash
printf 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart bot-game, /usr/bin/systemctl start bot-game, /usr/bin/systemctl stop bot-game, /usr/bin/systemctl is-active bot-game\n' | sudo tee /etc/sudoers.d/bot-game-deploy
sudo chmod 440 /etc/sudoers.d/bot-game-deploy
sudo visudo -c
```

Expected: `parsed OK`. Literal paths only — sudoers does not resolve `/bin` → `/usr/bin`.

- [ ] **Step 8: Verify the grant is exactly as narrow as intended**

```bash
sudo -u deploy sudo -n /usr/bin/systemctl is-active bot-game; echo "rc=$?"
sudo -u deploy sudo -n /usr/bin/systemctl restart nginx; echo "rc=$?"
```

Expected: first prints `inactive` (rc=3 — the unit exists but has never started, which is correct at this point); second FAILS with a password prompt refusal. If the second succeeds, the rule is too broad — stop and fix it.

- [ ] **Step 9: Enable the firewall**

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw --force enable
sudo ufw status verbose
```

Expected: 22 and 80 allowed, default deny incoming. Port 3000 needs no rule — `HOST=127.0.0.1` keeps it off the network entirely.

- [ ] **Step 10: Verify nginx answers and node does not**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.1.219/
curl -sS --max-time 3 http://192.168.1.219:3000/ ; echo "rc=$?"
```

Expected: `502` from nginx (nothing upstream yet — correct, and proves the proxy is wired), and a connection failure on 3000.

---

### Task 4: Add the CI workflow (build + verify)

**Files:**
- Create: `.github/workflows/ci-cd.yml`

**Interfaces:**
- Consumes: `deploy/deploy.sh` from Task 2.
- Produces: an artifact named `bot-game-<sha>` containing `bot-game-<sha>.tar.gz`; job ids `build`, `verify`, `deploy`.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci-cd.yml`:

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

# Deploys mutate one server; never run two at once. Do not cancel in progress -
# a half-finished deploy is worse than a queued one.
concurrency:
  group: cicd-${{ github.ref }}
  cancel-in-progress: false

env:
  NODE_VERSION: '22'
  ARTIFACT: bot-game-${{ github.sha }}

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - name: Install (locked)
        run: npm ci

      - name: Build
        run: npm run build

      # Tar before uploading: upload-artifact over a loose node_modules tree is
      # pathologically slow. Written to /tmp so tar never reads its own output.
      - name: Package artifact
        run: |
          tar czf "/tmp/${ARTIFACT}.tar.gz" \
            --exclude=./.git \
            --exclude=./.github \
            --exclude=./docs \
            -C . .
          ls -lh "/tmp/${ARTIFACT}.tar.gz"

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ env.ARTIFACT }}
          path: /tmp/${{ env.ARTIFACT }}.tar.gz
          retention-days: 14

  verify:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - uses: actions/download-artifact@v4
        with:
          name: ${{ env.ARTIFACT }}
          path: /tmp/artifact

      # Exercise the exact bytes that will be deployed - not the source tree.
      - name: Unpack artifact
        run: |
          mkdir -p /tmp/app
          tar xzf "/tmp/artifact/${ARTIFACT}.tar.gz" -C /tmp/app

      - name: Boot and smoke-test the artifact
        working-directory: /tmp/app
        run: |
          NODE_ENV=production HOST=127.0.0.1 PORT=3000 node start.mjs > /tmp/server.log 2>&1 &
          echo $! > /tmp/server.pid
          for i in $(seq 1 30); do
            body="$(curl -fsS --max-time 3 'http://127.0.0.1:3000/socket.io/?EIO=4&transport=polling' || true)"
            case "$body" in 0\{\"sid\"*) echo "handshake OK"; break ;; esac
            sleep 1
          done
          URL=http://127.0.0.1:3000 npm run smoke

      - name: Server log
        if: always()
        run: |
          kill "$(cat /tmp/server.pid)" 2>/dev/null || true
          tail -50 /tmp/server.log || true

  deploy:
    needs: [build, verify]
    if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    runs-on: [self-hosted, bot-game]
    environment: production
    steps:
      # The deploy script must exist before anything is untarred, so the job
      # checks out the repo for the script and takes app bytes only from the artifact.
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          name: ${{ env.ARTIFACT }}
          path: /tmp/artifact

      - name: Activate release
        run: bash deploy/deploy.sh "/tmp/artifact/${ARTIFACT}.tar.gz" "${GITHUB_SHA}"

      - name: Service status
        if: always()
        run: sudo /usr/bin/systemctl is-active bot-game || true
```

- [ ] **Step 2: Validate the YAML parses**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/ci-cd.yml','utf8');if(/\t/.test(s))throw new Error('tab character in YAML');console.log('no tabs, '+s.split('\n').length+' lines')"
```

Expected: no error. (Definitive validation happens when GitHub parses it in Step 4.)

- [ ] **Step 3: Commit and push on a branch**

```bash
git checkout -b ci/artifact-pipeline
git add .github/workflows/ci-cd.yml
git commit -m "ci: build once, verify the artifact, deploy via self-hosted runner"
git push -u origin ci/artifact-pipeline
```

- [ ] **Step 4: Watch build + verify run on the branch**

```bash
gh run watch "$(gh run list --branch ci/artifact-pipeline --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

Expected: `build` and `verify` both pass; `deploy` is skipped (not `main`). If `verify` fails, the pipeline has caught a genuinely broken artifact — fix that before going further; it is exactly the gate that is supposed to stop bad bytes.

---

### Task 5: Install and register the self-hosted runner

**Files:**
- Server: `/home/deploy/actions-runner/`, runner systemd service

**Interfaces:**
- Consumes: the `deploy` user from Task 3.
- Produces: a runner labelled `self-hosted,bot-game` online in the repo, running as a service under `deploy`.

- [ ] **Step 1: Confirm you have admin rights on the repo**

```bash
gh api repos/sayembillah-dev/B.O.T -q .permissions
```

Expected: `admin: true`. Without admin you cannot mint a registration token — stop and get access.

- [ ] **Step 2: Harden the public-repo settings BEFORE a runner exists**

A self-hosted runner on a public repo lets fork PRs execute code on the box unless fork workflows require approval. Set it first:

```bash
gh api -X PUT repos/sayembillah-dev/B.O.T/actions/permissions/fork-pr-workflows \
  -F approval_required_for_all_external_contributors=true 2>/dev/null \
  || echo "Set it in the UI: Settings > Actions > General > 'Require approval for all external contributors'"
```

Then confirm in the UI that **Fork pull request workflows from outside collaborators = Require approval for all external contributors**.

- [ ] **Step 3: Create the `production` environment**

```bash
gh api -X PUT repos/sayembillah-dev/B.O.T/environments/production
```

Expected: JSON describing the environment. This is what the `deploy` job binds to, and where a required reviewer can later be added.

- [ ] **Step 4: Download the runner onto the server**

Run as `deploy` on the host:

```bash
sudo -u deploy -H bash -lc '
  mkdir -p ~/actions-runner && cd ~/actions-runner &&
  curl -fsSL -o runner.tar.gz https://github.com/actions/runner/releases/download/v2.330.0/actions-runner-linux-x64-2.330.0.tar.gz &&
  tar xzf runner.tar.gz && rm runner.tar.gz && ls'
```

If that version 404s, take the current one from `gh api repos/actions/runner/releases/latest -q .tag_name` and substitute it in both places.

- [ ] **Step 5: Configure the runner with a fresh registration token**

```bash
TOKEN=$(gh api -X POST repos/sayembillah-dev/B.O.T/actions/runners/registration-token -q .token)
sudo -u deploy -H bash -lc "cd ~/actions-runner && ./config.sh --unattended --url https://github.com/sayembillah-dev/B.O.T --token $TOKEN --name play --labels bot-game --work _work"
```

The token expires in an hour; mint it fresh. `--labels bot-game` is what `runs-on: [self-hosted, bot-game]` targets.

- [ ] **Step 6: Install the runner as a service**

```bash
sudo bash -lc 'cd /home/deploy/actions-runner && ./svc.sh install deploy && ./svc.sh start'
sudo systemctl status "actions.runner.*" --no-pager | head -20
```

Expected: active (running), running as `deploy` — **not** root.

- [ ] **Step 7: Verify the runner is online and correctly labelled**

```bash
gh api repos/sayembillah-dev/B.O.T/actions/runners -q '.runners[] | {name, status, labels: [.labels[].name]}'
```

Expected: `status: "online"` with labels including `self-hosted` and `bot-game`.

---

### Task 6: First deploy, then prove the safety net works

**Files:** none (exercises Tasks 2–5)

**Interfaces:**
- Consumes: everything above.
- Produces: a live service at `http://192.168.1.219/` and evidence that a failed deploy rolls back.

- [ ] **Step 1: Merge the branch to `main`**

```bash
gh pr create --fill --base main --head ci/artifact-pipeline
gh pr merge --merge --delete-branch
```

Merging to `main` triggers a real deploy. This is the intended trigger, not an accident.

- [ ] **Step 2: Watch the full pipeline**

```bash
gh run watch "$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

Expected: `build` → `verify` → `deploy` all green. The `deploy` step log should show `Health check passed` then the smoke test's success output.

- [ ] **Step 3: Verify the service from outside the box**

```bash
curl -sS 'http://192.168.1.219/socket.io/?EIO=4&transport=polling' | head -c 60; echo
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.1.219/
```

Expected: a body beginning `0{"sid":` and `200`. The handshake is the real check — the 200 alone would pass even with a broken proxy.

- [ ] **Step 4: Verify the release layout on the server**

```bash
ssh nifty@192.168.1.219 'ls -l /srv/bot-game/current; ls -1 /srv/bot-game/releases; systemctl is-active bot-game; systemctl show bot-game -p MainPID --value | xargs -I{} ps -o user=,cmd= -p {}'
```

Expected: `current` → `releases/<sha>`, service `active`, process running as `botgame` executing `/usr/bin/node start.mjs`.

- [ ] **Step 5: Prove rollback works — deliberately break a release**

This is the one test that matters and it cannot be faked. On the server, hand-build a broken release and run the real activation path:

```bash
ssh nifty@192.168.1.219 'sudo -u deploy -H bash -lc "
  set -e
  cd /srv/bot-game/releases
  GOOD=\$(readlink -f /srv/bot-game/current)
  cp -a \"\$GOOD\" ./broken-test
  echo \"process.exit(1)\" > ./broken-test/start.mjs
  cd /tmp && tar czf /tmp/broken.tar.gz -C /srv/bot-game/releases/broken-test .
  rm -rf /srv/bot-game/releases/broken-test
"'
```

Then run the real activation path against that tarball:

```bash
scp deploy/deploy.sh nifty@192.168.1.219:/tmp/deploy.sh
ssh nifty@192.168.1.219 'sudo cp /tmp/deploy.sh /home/deploy/deploy.sh && sudo chown deploy:deploy /home/deploy/deploy.sh && sudo -u deploy -H bash /home/deploy/deploy.sh /tmp/broken.tar.gz broken-test; echo "exit=$?"'
```

Expected output: `Health check FAILED` → `Rolling back to <good sha>` → `Rollback healthy`, `exit=1`.

- [ ] **Step 6: Confirm the service survived the failed deploy**

```bash
curl -sS 'http://192.168.1.219/socket.io/?EIO=4&transport=polling' | head -c 20; echo
ssh nifty@192.168.1.219 'readlink -f /srv/bot-game/current'
```

Expected: handshake still valid, `current` pointing back at the known-good sha. Clean up: `sudo -u deploy rm -rf /srv/bot-game/releases/broken-test /tmp/broken.tar.gz`.

- [ ] **Step 7: Play a real game**

Open `http://192.168.1.219/` in two browsers on the LAN, create a room in one, join via the invite link in the other, start a match. This is the only check that covers the WebSocket upgrade end to end under real load.

---

### Task 7: Write the runbook and harden SSH

**Files:**
- Create: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: the verified procedure from Tasks 3–6.
- Produces: a runbook that reproduces this server from scratch, plus rollback and troubleshooting procedures.

- [ ] **Step 1: Write `docs/DEPLOYMENT.md`**

Sections, each with the exact commands that were actually run (not idealised ones):

1. **What this deploys** — architecture in five lines, and the single-process constraint with its consequence (deploys end live games).
2. **Provision from scratch** — Tasks 3 and 5 as a numbered, copy-pasteable list.
3. **How a deploy works** — trigger, the three jobs, symlink swap, health gate, auto-rollback.
4. **Manual rollback** — the two commands:

```bash
sudo -u deploy ln -sfn /srv/bot-game/releases/<sha> /srv/bot-game/current.tmp
sudo -u deploy mv -Tf /srv/bot-game/current.tmp /srv/bot-game/current
sudo systemctl restart bot-game
```

5. **Troubleshooting** — `journalctl -u bot-game -f`; `systemctl status actions.runner.*`; "handshake fails but `/` returns 200" → nginx upgrade headers; "deploy can't restart" → sudoers literal paths.
6. **Config changes** — edit `/etc/bot-game/env`, then restart. Never edit files under `releases/`; the next deploy discards them.
7. **Security posture** — the four public-repo mitigations, and the fact that no SSH key is stored in GitHub secrets.

- [ ] **Step 2: Rotate the disclosed key and disable password auth**

The ed25519 key was pasted into a chat transcript, and `nifty`/`nifty` is guessable. Generate a fresh key, install it, confirm it works in a *separate* session, then:

```bash
ssh nifty@192.168.1.219 'sudo sed -i "s/^#\?PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && sudo sshd -t && sudo systemctl reload ssh'
```

Do not run this until key auth is confirmed working from a second terminal — a broken `sshd_config` plus no password auth locks you out of the container.

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs: add deployment runbook"
git push
```

Note: this push to `main` triggers a deploy of a docs-only change. Harmless, and a useful confirmation that the pipeline is repeatable.
