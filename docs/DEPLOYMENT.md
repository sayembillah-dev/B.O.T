# Deployment runbook

This documents what was actually done to stand up `sayembillah-dev/B.O.T` on
its target server, not an idealised version. Where a step hasn't happened yet
(runner registration) or was deliberately deferred (SSH hardening), that's
called out explicitly rather than written as if it were done.

## 1. What this deploys

- Next.js 16.3.1 + React 19.2.8 behind a custom server (`server.js`) that runs
  Next **and** Socket.IO in one Node process, launched via `start.mjs`
  (`npm start`).
- CI builds the app once on GitHub-hosted infra, packages the built tree
  (including `node_modules`) as a `.tar.gz`, and a self-hosted runner on the
  target box unpacks those exact bytes under systemd. The server never runs
  `npm install`, `next build`, or `git`.
- nginx reverse-proxies `:80` to Node on `127.0.0.1:3000`, forwarding the
  WebSocket upgrade so Socket.IO doesn't silently degrade to long-polling.
- Target: `192.168.1.219` (`play`), an LXC container on Proxmox.

**Single-process constraint.** Room state is `const rooms = new Map()` —
in-process, in-memory. That forces exactly one Node process, always: no PM2
cluster mode, no replicas, no horizontal scaling. Any of those would silently
break room routing, because a second process would have its own empty `Map`.

**Consequence:** every deploy ends every in-flight game. There is no
zero-downtime path here — the systemd restart that activates a new release
kills every open room. Blue/green buys nothing when only one process may ever
run. The best available ceiling is what's implemented: an atomic symlink swap
plus a fast restart, with a health-gated auto-rollback so a bad release
doesn't stay live.

## 2. Provision from scratch

Server facts, established during provisioning:

- `192.168.1.219` (`play`), Debian GNU/Linux 13 "trixie", `x86_64`, glibc 2.41.
- LXC container on Proxmox; systemd is running inside it.
- 2 vCPU, 4.0 GiB RAM, 16 GB root disk.
- Node v22.23.2, installed from NodeSource (matches CI's Node 22 major).
- Two users: `deploy` (owns `/srv/bot-game`, will run the Actions runner,
  member of group `botgame`) and `botgame` (system account, `nologin`, runs
  the app under systemd).

(`x86_64`/glibc 2.41, and the 2 vCPU / 4.0 GiB / 16 GB sizing, come from the
pre-flight inspection recorded in §2 "Facts that constrain the design" of
`docs/superpowers/specs/2026-08-21-artifact-cicd-design.md`, not from the
Task 3 provisioning report — cited here so this doc's facts stay traceable.)

These are the exact commands that worked, run over SSH as `nifty` (the only
account that existed on the bare box), with two adaptations noted inline
where the naive form of a command didn't work.

### Step 1 — base packages

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg nginx ufw
```

`ca-certificates` was already present on this box's base image; everything
else (curl, gnupg, nginx, ufw) was not.

### Step 2 — Node 22 from NodeSource

**Adaptation:** the usual one-liner
(`curl -fsSL ... | sudo -E bash -`) does not work over an SSH session that's
piping the sudo password in (`sudo -S`) — the two pipes collide. Download the
script, then execute it as its own step:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/setup_22.x
sudo -E bash /tmp/setup_22.x
sudo apt-get install -y nodejs
node -v   # v22.23.2
```

### Step 3 — users and the release tree

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin botgame
sudo useradd --create-home --shell /bin/bash deploy
sudo mkdir -p /srv/bot-game/releases
sudo chown -R deploy:deploy /srv/bot-game
sudo chmod 755 /srv/bot-game /srv/bot-game/releases
sudo usermod -aG botgame deploy
```

The last line is required, not optional: `deploy/deploy.sh` runs
`chgrp -R botgame` on every release it unpacks (as the `deploy` user), so
`deploy` must already be a member of group `botgame` or every deploy fails at
the permissions step, before anything goes live.

Verify:

```bash
id deploy    # uid=1001(deploy) groups=1001(deploy),991(botgame)
id botgame   # uid=999(botgame) gid=991(botgame) groups=991(botgame)
```

### Step 4 — runtime env file

```bash
sudo mkdir -p /etc/bot-game
sudo bash -c "printf 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\n' > /etc/bot-game/env"
sudo chmod 640 /etc/bot-game/env
sudo chown root:botgame /etc/bot-game/env
```

**Adaptation:** write the file with `sudo bash -c "printf ... > file"`, not
`printf ... | sudo tee file`. Over a password-auth SSH session where sudo
itself needs `-S` to read a piped password, chaining a second pipe
(`printf ... | sudo -S tee file`) is ambiguous about which process reads
which stdin — in practice it wrote the literal password string into the file
instead of the intended content. Caught by checking the file size
immediately after (`ls -la`); the `bash -c` form avoids the trap entirely.
`/etc/bot-game/env` lives **outside** `releases/` on purpose — a deploy never
touches it, so it survives every release. `HOST=127.0.0.1` keeps Node off
the box's external interface; nginx is the only public listener.

### Step 5 — systemd unit

Copy the repo's `deploy/bot-game.service` to the box, then install it:

```bash
scp -i <key> -o IdentitiesOnly=yes deploy/bot-game.service deploy/nginx-bot-game.conf nifty@192.168.1.219:/tmp/
```

```bash
sudo cp /tmp/bot-game.service /etc/systemd/system/bot-game.service
sudo systemctl daemon-reload
sudo systemctl enable bot-game
```

Do **not** start it here — there's no release at `/srv/bot-game/current` yet.
Verify it's enabled but inactive:

```bash
sudo systemctl is-active bot-game    # inactive
sudo systemctl is-enabled bot-game   # enabled
```

### Step 6 — nginx site

```bash
sudo cp /tmp/nginx-bot-game.conf /etc/nginx/sites-available/bot-game
sudo ln -sfn /etc/nginx/sites-available/bot-game /etc/nginx/sites-enabled/bot-game
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

At this point `curl http://192.168.1.219/` returns `502` (nginx is up, Node
is not) — that's the expected state, not a failure.

### Step 7 — sudoers drop-in

`deploy/deploy.sh` needs to restart the service without a password, and
nothing more:

```bash
sudo bash -c "printf 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart bot-game, /usr/bin/systemctl start bot-game, /usr/bin/systemctl stop bot-game, /usr/bin/systemctl is-active bot-game\n' > /etc/sudoers.d/bot-game-deploy"
sudo chmod 440 /etc/sudoers.d/bot-game-deploy
sudo visudo -c
```

Use the literal absolute path `/usr/bin/systemctl` — sudoers matches command
lines literally, and that's exactly the path `deploy.sh` invokes
(`grep -n sudo deploy/deploy.sh` shows the one call). `/bin/systemctl` is
only a symlink on Debian 13 and will **not** match.

Verify the grant is exactly this narrow, no more:

```bash
sudo -u deploy sudo -n /usr/bin/systemctl is-active bot-game   # succeeds, rc=3 (inactive)
sudo -u deploy sudo -n /usr/bin/systemctl restart nginx        # "a password is required"
```

### Step 8 — the Actions runner (NOT YET DONE)

**Status: not done.** Repo admin on `sayembillah-dev/B.O.T` was never
granted, so this step has not run. Until it does, the `deploy` job in
`.github/workflows/ci-cd.yml` (`runs-on: [self-hosted, bot-game]`) has no
runner to pick it up and **queues forever** on every push to `main`. Deploys
must be done by hand — see §4 below — until this is complete.

**Do not register the runner until the two prerequisites below are done.**
Registering it first — before the fork-approval setting is applied — leaves
a window where a fork PR can define its own job targeting
`runs-on: [self-hosted, bot-game]` and have it execute automatically on this
LAN box. See §8 for why the `deploy` job's own `if:` guard does not close
that window.

**Prerequisite (a) — set the fork-approval setting, first, before anything
else in this step:**

In **Settings → Actions → General → Fork pull request workflows from
outside collaborators**, set **"Require approval for all outside
collaborators"** (GitHub's current label for what the spec calls "Require
approval for all external contributors"). Requires repo admin.

**Prerequisite (b) — create the `production` GitHub Environment**, which §3
and §8 already assume exists (it's what the `deploy` job in
`ci-cd.yml` binds to):

```bash
gh api -X PUT repos/sayembillah-dev/B.O.T/environments/production
```

Only once both of those are done, proceed with the runner itself:

```bash
# on the server, as deploy
mkdir -p /home/deploy/actions-runner && cd /home/deploy/actions-runner
curl -o actions-runner-linux-x64-2.336.0.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-x64-2.336.0.tar.gz
tar xzf actions-runner-linux-x64-2.336.0.tar.gz
```

A registration token is required — mint it with a `gh` account that has repo
admin:

```bash
gh api -X POST repos/sayembillah-dev/B.O.T/actions/runners/registration-token -q .token
```

(or copy one from the GitHub UI: **Settings → Actions → Runners → New
self-hosted runner**, which shows the same token for a limited time). Then,
still as `deploy`:

```bash
./config.sh --url https://github.com/sayembillah-dev/B.O.T \
  --token <token> --name play --labels bot-game --unattended
sudo ./svc.sh install deploy
sudo ./svc.sh start
```

`--name play` matches the host's hostname, per plan. The label `bot-game` is
what `runs-on: [self-hosted, bot-game]` in the workflow targets — it must be
exactly this string. Installing the service as `deploy` (not root) matches
the security model in §8.

### Step 9 — firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw --force enable
```

Run all three in **one** SSH command/session. If `--force enable` runs before
the `allow 22/tcp` rule is in place, or the connection drops between the two
commands, the box locks itself out over SSH (recoverable only via the Proxmox
console). Confirm from a fresh connection (not a reused session) immediately
after:

```bash
ssh -i <key> -o ConnectTimeout=10 nifty@192.168.1.219 'echo RECONNECT_OK; sudo ufw status'
```

Port 3000 needs no explicit rule — it's already loopback-only via
`HOST=127.0.0.1` in `/etc/bot-game/env`, and ufw's default-deny drops
external traffic to it anyway.

### Step 10 — SSH hardening (PENDING — do not run yet)

**Deliberately not done.** See §8 for why, and the exact commands to run once
the runner (§2 Step 8) is registered and the `deploy` account setup is
otherwise finished. Locking down SSH now, before those are confirmed
working, risks losing terminal access to the container with no other path
in.

## 3. How a deploy works

This describes the pipeline's *designed* behavior. As of this writing the
`deploy` job below has no runner to run on (§2 Step 8) — every push to `main`
queues it forever, and the actual deploy is done by hand per §4.

Trigger: a `push` to `main`, or a manual `workflow_dispatch` run. (A
`pull_request` event runs `build` and `verify` only — the `deploy` job's
`if:` condition excludes it, and this has been verified empirically on a live
PR-triggered run.)

Three jobs, in order:

1. **`build`** (`ubuntu-latest`) — `npm ci`, `npm run build`, then
   `tar czf bot-game-<sha>.tar.gz` of the built worktree (excluding `.git`,
   `.github`, `docs`), uploaded as a CI artifact (14-day retention).
2. **`verify`** (`ubuntu-latest`, needs `build`) — downloads the *artifact*
   (not the source), untars it, boots it with `node start.mjs`, polls for a
   real Engine.IO handshake (`0{"sid":...`, not a bare 200), then runs
   `npm run smoke` against it. This exercises the exact bytes that would be
   deployed.
3. **`deploy`** (`[self-hosted, bot-game]`, needs `build` + `verify`, gated by
   `github.ref == 'refs/heads/main' && github.event_name != 'pull_request'`,
   bound to the `production` GitHub Environment) — checks out the repo (for
   `deploy/deploy.sh` only), downloads the artifact, then runs
   `deploy/deploy.sh <tarball> <sha>` on the server:
   - untars into `/srv/bot-game/releases/<sha>/` — **except** when `<sha>` is
     already the live release (a re-run, or a retry after a failed deploy of
     the same commit): then it untars into
     `/srv/bot-game/releases/<sha>.redeploy-<timestamp>-<pid>/` instead, so
     the running release is never `rm -rf`'d out from under itself. `current`
     may therefore point at a `.redeploy-*` directory rather than a bare
     `<sha>` one; `ls -1 /srv/bot-game/releases` (§5) always shows the real
     name to use.
   - records the current `current` symlink target as the rollback point
   - fixes group ownership so `botgame` (the service user) can read/execute
     the release and write `.next/cache`, since the release was unpacked as
     `deploy`
   - **symlink swap**: `ln -sfn <new> current.tmp && mv -Tf current.tmp current`
     (atomic — `current` is never briefly missing or half-updated)
   - `sudo /usr/bin/systemctl restart bot-game`
   - **health gate**: polls `http://127.0.0.1/socket.io/?EIO=4&transport=polling`
     through nginx for up to 30s, looking specifically for an Engine.IO
     handshake body, not just HTTP 200
   - runs `URL=http://127.0.0.1 node scripts/smoke-test.mjs` directly from the
     release directory against the live service (not via the `npm run smoke`
     script — reproduce it by hand with that same command and env var)
   - **on any failure** at activation, health, or smoke: repoints the symlink
     back to the previous release, restarts, and exits 1 — this rollback is
     not re-entrant (if the rollback itself fails, the script logs "manual
     intervention needed" and exits 1 rather than retrying)
   - **on success**: prunes all releases except the 5 most recent (never
     prunes whatever `current` points at, even if it's older than the 5 kept)

Because there's exactly one Node process (§1), the `systemctl restart` step
in the middle of this ends every in-flight game — that's expected on every
successful deploy, not just failed ones.

## 4. Manual deploy (the actual operative path right now)

Since the runner isn't registered (§2 Step 8), this is what has been used in
practice to deploy, and remains the correct procedure until that changes.

```bash
# 1. find the run and download its artifact
gh run list --repo sayembillah-dev/B.O.T --branch main --limit 5
gh run view <run-id> --repo sayembillah-dev/B.O.T --json jobs \
  -q '.jobs[] | "\(.name)\t\(.status)\t\(.conclusion)"'

gh api repos/sayembillah-dev/B.O.T/actions/runs/<run-id>/artifacts
gh run download <run-id> --repo sayembillah-dev/B.O.T \
  -n bot-game-<sha> -D /tmp/art

# 2. copy the artifact and the deploy script to the server
scp -i <key> -o IdentitiesOnly=yes /tmp/art/bot-game-<sha>.tar.gz \
  nifty@192.168.1.219:/tmp/bot-game-artifact.tar.gz
scp -i <key> -o IdentitiesOnly=yes deploy/deploy.sh nifty@192.168.1.219:/tmp/deploy.sh

# 3. move into deploy's home with correct ownership, then run it as deploy
ssh -i <key> nifty@192.168.1.219 '
  sudo cp /tmp/bot-game-artifact.tar.gz /home/deploy/bot-game-artifact.tar.gz
  sudo cp /tmp/deploy.sh /home/deploy/deploy.sh
  sudo chown deploy:deploy /home/deploy/bot-game-artifact.tar.gz /home/deploy/deploy.sh
  sudo chmod +x /home/deploy/deploy.sh
'
ssh -i <key> nifty@192.168.1.219 \
  'sudo -u deploy -H bash /home/deploy/deploy.sh /home/deploy/bot-game-artifact.tar.gz <sha>'
```

The `<sha>` argument must be the commit SHA the artifact was built from
(`github.sha` in the run, i.e. the real commit on `main` for a `push`-triggered
run — not the ephemeral merge ref a `pull_request`-triggered run would have
used). This is exactly what `deploy/deploy.sh` inside the workflow's `deploy`
job would run — same script, same artifact bytes, run by hand because no
runner exists to run it automatically.

Whenever a run's `deploy` job is left `queued` because of this (every push to
`main` currently does this), cancel it once the manual deploy is done so it
doesn't hold the `cicd-refs/heads/main` concurrency group open for the next
run:

```bash
gh run cancel <run-id> --repo sayembillah-dev/B.O.T
```

## 5. Manual rollback

Releases are pruned to the last 5 kept, so pick a target that's actually
present:

```bash
ssh -i <key> nifty@192.168.1.219 'ls -1 /srv/bot-game/releases'
```

Then, from an account with full sudo on the box (e.g. `nifty`):

```bash
sudo -u deploy ln -sfn /srv/bot-game/releases/<sha> /srv/bot-game/current.tmp
sudo -u deploy mv -Tf /srv/bot-game/current.tmp /srv/bot-game/current
sudo systemctl restart bot-game
```

(Running this as `deploy` itself would fail on the third command — `deploy`'s
sudoers grant only matches the literal `/usr/bin/systemctl` argv, not a bare
`systemctl` resolved via `$PATH`. As `deploy`, use
`sudo -n /usr/bin/systemctl restart bot-game` instead.)

This is the exact symlink-swap-then-restart sequence `deploy.sh` uses
internally. It does not run the health gate or smoke test — check manually
afterward:

```bash
curl -sS 'http://192.168.1.219/socket.io/?EIO=4&transport=polling'
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.1.219/
```

## 6. Troubleshooting

**Service logs:**

```bash
sudo journalctl -u bot-game -f
```

**Which release is actually live:**

```bash
readlink -f /srv/bot-game/current
```

**Handshake fails, but `curl http://192.168.1.219/` returns 200.** The proxy
is up and serving HTML fine while WebSockets are broken — check the nginx
upgrade headers in `/etc/nginx/sites-available/bot-game`:

```bash
sudo nginx -T | grep -A3 'map \$http_upgrade'
```

Should show the `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`
block and `proxy_set_header Upgrade $http_upgrade;` / `Connection $connection_upgrade;`
inside `location /`. Without these, Socket.IO silently falls back to
long-polling and behaves erratically instead of failing loudly, so a bare 200
on `/` proves nothing — this is exactly why the health gate in `deploy.sh`
checks for the Engine.IO handshake body, not a status code.

**Deploy script can't restart the service** (`sudo: a password is required`,
or the restart step fails inside `deploy.sh`). The sudoers grant matches on
literal command lines — check it's using `/usr/bin/systemctl`, not
`/bin/systemctl` (a symlink on Debian 13) or a bare `systemctl` relying on
`$PATH`:

```bash
sudo cat /etc/sudoers.d/bot-game-deploy
sudo -u deploy sudo -n -l /usr/bin/systemctl restart bot-game   # should print the command, rc=0
```

**The `deploy` job is stuck `queued` in Actions, and it's blocking the next
push to `main`.** No self-hosted runner labelled `bot-game` is registered —
see §2 Step 8. This isn't just a stalled job: the workflow's
`concurrency: cicd-${{ github.ref }}` group with `cancel-in-progress: false`
means a queued `deploy` holds that group open, so the *next* push's run
can't even start (it sits `pending`) until this one resolves. Left alone,
GitHub's own queue limit is the only thing that eventually clears it — on
the order of a day, not minutes. The job's `timeout-minutes: 10` does
**not** help here: that clock only starts once a runner picks the job up,
and with none registered it never does. Until the runner exists (§2 Step
8), every push leaves its `deploy` job queued this way and it must be
cancelled by hand:

```bash
gh run cancel <run-id> --repo sayembillah-dev/B.O.T
```

Check for a runner process on the server first, to confirm this is really
the "no runner" case and not something else:

```bash
ssh -i <key> nifty@192.168.1.219 'systemctl status "actions.runner.*" 2>&1 || echo "no runner service installed"'
```

If nothing is installed, the runner has never been registered; deploy by
hand per §4, then cancel the queued run as above.

**Service won't start / crashes on boot.** Check `EnvironmentFile` is
readable by `botgame` and `ExecStart`'s target exists:

```bash
sudo -u botgame test -r /etc/bot-game/env && echo readable
ls -l /usr/bin/node
sudo systemctl status bot-game --no-pager
```

## 7. Config changes

Runtime config lives at `/etc/bot-game/env`, outside `releases/` on purpose:

```bash
sudo $EDITOR /etc/bot-game/env
sudo systemctl restart bot-game
```

Never edit anything under `/srv/bot-game/releases/<sha>/` — the next deploy
overwrites the whole directory (`rm -rf "$NEW"` before unpacking), so any
manual edit there is silently discarded on the next deploy, including the
`current` release once a newer one is activated.

## 8. Security posture

A self-hosted runner on a **public** repo is the main risk here: for a
`pull_request` event, GitHub takes the *workflow definition itself* from the
fork's branch. That means a fork PR is not limited to triggering the
existing `deploy` job — it can add its own job in its own copy of
`ci-cd.yml` with `runs-on: [self-hosted, bot-game]`, and that job is not
constrained by this repo's `deploy` job's `if:` condition at all, because
it's a different job the fork authored. Unless something stops it upstream
of the workflow file being read, a fork-authored job like that would execute
automatically on this LAN box.

**Primary control:** the repo setting **"Require approval for all outside
collaborators"** (Settings → Actions → General → Fork pull request
workflows from outside collaborators — this is what the spec calls "Require
approval for all external contributors"). This is what actually stops a
fork-authored job from running on the self-hosted runner at all — it gates
*any* workflow run originating from a fork PR before it starts, regardless
of what job the fork wrote. **Not yet confirmed set** — repo admin access
has not been granted (see §2 Step 8). **Do not register the runner (§2 Step
8) until this is confirmed set** — see the warning at the top of that step.

The following mitigations are real, but they protect the *existing*
`deploy` job's path specifically, not the runner in general — they do not
substitute for the fork-approval setting above:

1. The `deploy` job (the one defined in `ci-cd.yml` on `main`) never runs on
   `pull_request` — only `push` to `main` (requires write access) or manual
   `workflow_dispatch`. Verified empirically: a live `pull_request`-triggered
   run showed `deploy` as `skipped`. This guard only constrains *this job as
   it exists on `main`*; it cannot constrain a different job a fork PR
   defines in its own workflow file.
2. `deploy` is bound to the `production` GitHub Environment, which can
   require a reviewer and can be restricted to `main`.
3. The runner runs as unprivileged `deploy`, never root, with a sudoers grant
   narrowed to four specific `systemctl` subcommands on one unit (§2 Step 7).
4. Sudoers uses the literal `/usr/bin/systemctl` path, matched against the
   exact argv `deploy.sh` invokes — no wildcard, no `ALL`.

No SSH key is stored in GitHub secrets under this model — the runner
authenticates outbound to GitHub with its own registration token, not with a
key checked into the repo or Actions secrets. SSH to the server is only ever
used from this machine, by hand, for provisioning and manual deploys.

**Outstanding credential hygiene issues (unresolved, tracked here rather than
silently fixed):**

- The ed25519 key used to reach this server was pasted into a chat transcript
  during provisioning and must be treated as disclosed. It should be
  rotated — generate a new key, install it, confirm it works from a *second*
  terminal session before removing the old one.
- The `nifty` account's password is `nifty` — a guessable, weak
  username/password pair. Password auth is currently **enabled** on the box.
- SSH hardening (disabling password auth once key auth is confirmed) is
  documented as a pending step in §2 Step 10, not yet performed. The exact
  command, to run only after key auth is reconfirmed from a second terminal:

  ```bash
  ssh nifty@192.168.1.219 'sudo sed -i "s/^#\?PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && sudo sshd -t && sudo systemctl reload ssh'
  ```

  Do not run this until a second terminal has confirmed key-only login
  works — a broken `sshd_config` combined with password auth already off
  would lock out the container with no recovery path short of the Proxmox
  console.
