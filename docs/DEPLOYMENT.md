# Deployment runbook

This documents what was actually done to stand up `sayembillah-dev/B.O.T` on
its target server, not an idealised version. The self-hosted runner is now
registered and running (§2 Step 8), and the automated pipeline has deployed
end-to-end on it (§3). Where a step was deliberately deferred (SSH
hardening), that's called out explicitly rather than written as if it were
done.

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

### Step 8 — the Actions runner (DONE)

**Status: done.** A self-hosted runner named `play` is registered on
`sayembillah-dev/B.O.T`, installed from `/home/deploy/actions-runner`
(actions-runner v2.336.0 linux-x64), and running as the systemd service
`actions.runner.sayembillah-dev-B.O.T.play.service` under the unprivileged
`deploy` user (not root, per the security model in §8). Labels:
`self-hosted, Linux, X64, bot-game`. Confirm it's up:

```bash
sudo systemctl status actions.runner.sayembillah-dev-B.O.T.play.service
gh api repos/sayembillah-dev/B.O.T/actions/runners
```

Both prerequisites below were satisfied first, in that order, before the
runner was registered. Registering it first — before the fork-approval
setting was applied — would have left a window where a fork PR could define
its own job targeting `runs-on: [self-hosted, bot-game]` and have it execute
automatically on this LAN box. See §8 for why the `deploy` job's own `if:`
guard does not close that window. If this box is ever rebuilt, do the two
prerequisites first, in this order, before registering a new runner.

**Prerequisite (a) — fork-approval setting — applied:**

In **Settings → Actions → General → Fork pull request workflows from
outside collaborators**, set to **"Require approval for all outside
collaborators"** (GitHub's current label for what the spec calls "Require
approval for all external contributors"). Confirmed applied — see §8 for the
verification command and why this is the primary control against a
self-hosted runner on a public repo.

**Prerequisite (b) — the `production` GitHub Environment — created:**

```bash
gh api -X PUT repos/sayembillah-dev/B.O.T/environments/production
```

Exists now; §3 and §8 already assume it does (it's what the `deploy` job in
`ci-cd.yml` binds to). It currently has no required reviewers configured —
adding one is an optional extra gate, see §8.

The runner itself was installed like this — kept here as the reference for
rebuilding the box, not as a pending step:

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
self-hosted runner**, which shows the same token for a limited time). In
practice this token was minted using the repo owner's PAT, written to the
server, consumed once by `config.sh`, and deleted — see §8 for that PAT's
own disposition (it needs to be revoked and rotated). Then, still as
`deploy`:

```bash
./config.sh --url https://github.com/sayembillah-dev/B.O.T \
  --token <token> --name play --labels bot-game --unattended
sudo ./svc.sh install deploy
sudo ./svc.sh start
```

`--name play` matches the host's hostname, per plan. The label `bot-game` is
what `runs-on: [self-hosted, bot-game]` in the workflow targets — it must be
exactly this string; GitHub appends its own default labels
(`self-hosted, Linux, X64`) automatically, which is why the runner's full
label set ends up as `self-hosted, Linux, X64, bot-game`. Installing the
service as `deploy` (not root) matches the security model in §8.

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

**Deliberately not done.** The runner (§2 Step 8) is registered and the
`deploy` account setup is otherwise finished, but SSH hardening itself still
requires the two-terminal confirmation described in §8 before it runs —
locking down SSH before key-only login is reconfirmed from a second terminal
risks losing terminal access to the container with no other path in. See §8
for the exact commands and that safety procedure.

## 3. How a deploy works

This is the automated path, and it is proven end-to-end on the self-hosted
runner: two full runs have gone build → verify → deploy all green with no
human touching the server — run `32484940339` (deployed `e6e35c4`) and run
`32488039952` (a manual `workflow_dispatch`, deployed `d78679b`). Every push
to `main` since has gone through this same automated path; `readlink -f
/srv/bot-game/current` (§6) is the authority on what's actually live at any
given moment, not this doc. §4's manual procedure is now break-glass only,
for when the runner is down.

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

## 4. Manual deploy (break-glass — use when the runner is down)

The automated path (§3) is what actually deploys now. This procedure is kept
as the recovery path for when the self-hosted runner is offline (see §6's
"Waiting for a runner to pick up this job" entry) — it's exactly what
`deploy/deploy.sh` inside the workflow's `deploy` job would run, just
triggered by hand instead of by the runner.

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
job would run — same script, same artifact bytes, run by hand instead of by
the runner because it isn't available right now.

If this procedure is being run because the runner is down, see §6 for how to
confirm that and bring it back. Once it's back online, any run still sitting
`queued` behind it picks the job up and runs on its own — no manual cancel
needed for the routine case.

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

**A `deploy` job is stuck on "Waiting for a runner to pick up this job."**
The self-hosted runner service is down. Confirm on the server (as `nifty`,
same as every other SSH example here — `deploy`'s sudoers grant only covers
the four `systemctl bot-game` subcommands in §2 Step 7, not this):

```bash
ssh -i <key> nifty@192.168.1.219 "sudo systemctl status 'actions.runner.*'"
```

and confirm from the GitHub side that it doesn't show as online:

```bash
gh api repos/sayembillah-dev/B.O.T/actions/runners
```

If `actions.runner.sayembillah-dev-B.O.T.play.service` isn't `active`,
restart it:

```bash
ssh -i <key> nifty@192.168.1.219 \
  'sudo systemctl restart actions.runner.sayembillah-dev-B.O.T.play.service'
```

and the queued job picks up on its own — no need to cancel and re-run. If it
won't come back, deploy by hand per §4 while it's investigated. Note the
workflow's `concurrency: cicd-${{ github.ref }}` group
(`cancel-in-progress: false`) means a run stuck this way still holds that
group open, so the *next* push's run can't start until this one resolves —
don't leave a downed runner unattended for long.

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
approval for all external contributors"; the underlying API setting is
`actions/permissions/fork-pr-contributor-approval`). This is what actually
stops a fork-authored job from running on the self-hosted runner at all — it
gates *any* workflow run originating from a fork PR before it starts,
regardless of what job the fork wrote. **Applied** — the setting is
`all_external_contributors`, not the risky default
(`first_time_contributors`, which only requires approval the *first* time a
given outside contributor opens a PR). It was set before the runner (§2 Step
8) was registered, for exactly this reason. Verify:

```bash
gh api repos/sayembillah-dev/B.O.T/actions/permissions/fork-pr-contributor-approval
```

The following mitigations are real, but they protect the *existing*
`deploy` job's path specifically, not the runner in general — they do not
substitute for the fork-approval setting above:

1. The `deploy` job (the one defined in `ci-cd.yml` on `main`) never runs on
   `pull_request` — only `push` to `main` (requires write access) or manual
   `workflow_dispatch`. Verified empirically: a live `pull_request`-triggered
   run showed `deploy` as `skipped`. This guard only constrains *this job as
   it exists on `main`*; it cannot constrain a different job a fork PR
   defines in its own workflow file.
2. `deploy` is bound to the `production` GitHub Environment (created via the
   API — §2 Step 8b). It currently has **no required reviewers** configured;
   adding one would be an optional extra gate on top of the fork-approval
   control above, not a substitute for it.
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

- A GitHub Personal Access Token belonging to the repo owner
  (`sayembillah-dev`) was pasted into a chat transcript during setup. It
  carried near-total scopes (`repo`, `workflow`, `admin:org`,
  `admin:enterprise`, `delete_repo`, `admin:public_key`, and more) — full
  account control, not a scoped deploy credential. **It must be revoked and
  regenerated.** It was used only to apply the fork-approval setting above,
  create the `production` environment (§2 Step 8b), and mint the runner's
  short-lived registration token (§2 Step 8); the registration token itself
  was written to the server, used once by `config.sh`, and deleted. The PAT
  was never written to the server or committed to the repo — but a value
  pasted into chat still has to be treated as disclosed.
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
