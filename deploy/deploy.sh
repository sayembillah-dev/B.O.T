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
