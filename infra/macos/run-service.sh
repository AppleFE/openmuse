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
  server|browser-worker|web) ;;
  *) echo "usage: $0 server|browser-worker|web" >&2; exit 64 ;;
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
esac
