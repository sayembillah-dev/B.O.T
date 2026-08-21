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
    ln -sfn "$1" "$APP_ROOT/current.tmp" \
        && mv -Tf "$APP_ROOT/current.tmp" "$CURRENT" \
        && sudo /usr/bin/systemctl restart bot-game
}

# Roll back to the previous release. Never re-entrant: a failure during
# rollback is logged and the script exits 1 - it does not call rollback()
# again.
rollback() {
    log "FAILED: $1"
    if [ "$SAME_SHA" -eq 1 ]; then
        # PREVIOUS is $SHA itself (same-SHA redeploy, see below) - reactivating
        # it would just replay the identical bits that already failed, not a
        # real recovery. Fail loudly instead of pretending a no-op is a
        # rollback. The original live directory was never touched by this
        # run, so it is still on disk under $PREVIOUS if manual intervention
        # needs it.
        log "This was a same-SHA redeploy of $SHA - refusing to \"roll back\" to the identical SHA. The previous live release at $(basename "$PREVIOUS") was never modified; investigate manually."
        exit 1
    fi
    if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
        log "Rolling back to $(basename "$PREVIOUS")"
        if activate "$PREVIOUS" && health; then
            log "Rollback healthy"
        else
            log "Rollback is ALSO unhealthy - manual intervention needed"
        fi
    else
        log "No previous release to roll back to"
    fi
    exit 1
}

PREVIOUS=""
[ -L "$CURRENT" ] && PREVIOUS="$(readlink -f "$CURRENT")"

NEW="$RELEASES/$SHA"

# Detect a same-SHA redeploy (workflow re-run, workflow_dispatch on unchanged
# main, or a retry): $NEW would resolve to the exact directory that is
# currently live ($PREVIOUS). Match by basename, not just direct path
# equality, so this still fires correctly on a *second* consecutive
# same-SHA redeploy, where $PREVIOUS is itself a ".redeploy-*" directory
# from the first one.
SAME_SHA=0
if [ -n "$PREVIOUS" ]; then
    case "$(basename "$PREVIOUS")" in
        "$SHA" | "$SHA".*) SAME_SHA=1 ;;
    esac
fi

if [ "$SAME_SHA" -eq 1 ]; then
    # NEVER rm -rf the directory a same-SHA redeploy would otherwise target -
    # that directory IS the live release. Unpack into a distinct sibling
    # directory instead, so the live release is never absent or partial:
    # the old directory is left completely untouched until the new one has
    # been fully unpacked, permission-prepped, and activated via the normal
    # atomic symlink swap in activate(). PREVIOUS still points at the
    # original, intact directory throughout.
    NEW="$RELEASES/${SHA}.redeploy-$(date +%s)-$$"
    log "SHA $SHA is already live (at $(basename "$PREVIOUS")) - this is a same-SHA redeploy. Unpacking to a fresh directory ($(basename "$NEW")) instead of touching the live one."
fi

log "Unpacking $(basename "$TARBALL") -> $NEW"
rm -rf "$NEW"
mkdir -p "$NEW"
tar xzf "$TARBALL" -C "$NEW"
[ -f "$NEW/start.mjs" ] || { echo "artifact missing start.mjs"; exit 1; }
[ -d "$NEW/.next" ]     || { echo "artifact missing .next build output"; exit 1; }

# The service runs as User=botgame (see bot-game.service) but releases are
# extracted as `deploy`. Make the release group-readable and .next/cache
# group-writable so botgame can run it. Requires `deploy` to be a member of
# group `botgame` on the host. This is fatal and runs before activation, so
# nothing is live yet if it fails.
log "Preparing release permissions for the botgame service user"
mkdir -p "$NEW/.next/cache" \
    && chgrp -R botgame "$NEW" \
    && chmod -R g+rX "$NEW" \
    && chmod -R g+w "$NEW/.next/cache" \
    || { echo "failed to prepare release permissions for botgame (is deploy in group botgame?)"; exit 1; }

log "Activating $SHA"
activate "$NEW" || rollback "activation (symlink swap or systemctl restart failed)"

health || rollback "health check (no Engine.IO handshake within 30s)"
log "Health check passed"

log "Running smoke test against the live service"
( cd "$NEW" && URL=http://127.0.0.1 node scripts/smoke-test.mjs ) || rollback "smoke test"

log "Pruning old releases (keeping $KEEP)"
LIVE="$(readlink -f "$CURRENT")"
prune_failed=0
prune_list="$(mktemp)"
# List into a temp file (not a pipe) so the loop body below runs in this
# shell, not a subshell - a failing `rm -rf` in a subshell would otherwise
# be swallowed by `pipefail` and abort the whole script after the release
# is already healthy and live.
# shellcheck disable=SC2012
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n "+$((KEEP + 1))" > "$prune_list"
while IFS= read -r old; do
    [ -z "$old" ] && continue
    [ "$(readlink -f "$old")" = "$LIVE" ] && continue
    rm -rf "$old" || { log "WARNING: failed to prune $old"; prune_failed=1; }
done < "$prune_list"
rm -f "$prune_list"
[ "$prune_failed" -eq 0 ] || log "WARNING: one or more old releases could not be pruned (deploy already succeeded, not failing the run)"

log "Deployed $SHA"
