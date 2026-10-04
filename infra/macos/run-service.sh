#!/bin/sh
set -eu

umask 077
service=${1:-}
root=/Volumes/p41-1tb/openmuse
volume=/Volumes/p41-1tb
repo=$root/repo
env_file=$repo/.env
node=$root/runtime/node-current/bin/node

case "$service" in
  server|browser-worker|web|ollama|host-agent) ;;
  *) echo "usage: $0 server|browser-worker|web|ollama|host-agent" >&2; exit 64 ;;
esac

attempt=0
while [ "$attempt" -lt 15 ]; do
  mount_point=$(/bin/df -P "$root" 2>/dev/null | /usr/bin/awk 'NR == 2 { print $6 }' || true)
  [ "$mount_point" = "$volume" ] && break
  attempt=$((attempt + 1))
  /bin/sleep 2
done
if [ "${mount_point:-}" != "$volume" ]; then
  echo "OpenMuse volume is not mounted at $volume; refusing to use the system disk" >&2
  exit 75
fi

if [ "$service" = ollama ]; then
  ollama=$root/runtime/ollama/Ollama.app/Contents/Resources/ollama
  models=$root/data/models/ollama
  state=$root/data/ollama-home
  for required in "$ollama" "$models" "$state"; do
    if [ ! -e "$required" ]; then
      echo "Required local inference path is missing: $required" >&2
      exit 78
    fi
  done
  [ -x "$ollama" ] || { echo "Ollama CLI is not executable: $ollama" >&2; exit 78; }
  exec /usr/bin/env \
    HOME="$state" \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_MODELS="$models" \
    OLLAMA_NO_CLOUD=1 \
    OLLAMA_KEEP_ALIVE=5m \
    OLLAMA_NUM_PARALLEL=1 \
    OLLAMA_MAX_LOADED_MODELS=1 \
    OLLAMA_MAX_QUEUE=8 \
    OLLAMA_CONTEXT_LENGTH=8192 \
    "$ollama" serve
fi

for required in "$repo/package.json" "$env_file" "$node"; do
  if [ ! -e "$required" ]; then
    echo "Required deployment file is missing: $required" >&2
    exit 78
  fi
done
mode=$(/usr/bin/stat -f '%Lp' "$env_file")
case "$mode" in
  400|600) ;;
  *) echo "$env_file must have mode 600 (or stricter); found $mode" >&2; exit 77 ;;
esac

cd "$repo"
"$node" infra/macos/validate-env.mjs --env "$env_file" --root "$root" --infrastructure-only
case "$service" in
  server)
    # launchd/sshd uses a minimal PATH; Docker is installed under Homebrew on Apple silicon.
    PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    export PATH
    "$node" infra/macos/validate-env.mjs --env "$env_file" --root "$root"
    [ -f dist/apps/server/src/index.js ] || { echo "Server build is missing; run infra/macos/deploy.sh" >&2; exit 78; }
    exec "$node" --env-file="$env_file" dist/apps/server/src/index.js
    ;;
  browser-worker)
    exec "$node" --env-file="$env_file" --experimental-strip-types apps/worker/src/index.ts
    ;;
  web)
    [ -f apps/mobile/dist/web/index.html ] || { echo "Web build is missing; run infra/macos/deploy.sh" >&2; exit 78; }
    exec "$node" --env-file="$env_file" infra/macos/serve-web.mjs
    ;;
  host-agent)
    [ -f dist/host-agent/run.mjs ] || { echo "Host Agent build is missing" >&2; exit 78; }
    [ -f "$root/data/host-agent/config.json" ] || { echo "Host Agent config is missing" >&2; exit 78; }
    PLAYWRIGHT_BROWSERS_PATH="$root/caches/playwright"
    PATH="$root/runtime/node-current/bin:/opt/homebrew/bin:/Users/aeonge/.cargo/bin:/Users/aeonge/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    export PLAYWRIGHT_BROWSERS_PATH PATH
    exec "$node" dist/host-agent/run.mjs "$root/data/host-agent/config.json"
    ;;
esac
