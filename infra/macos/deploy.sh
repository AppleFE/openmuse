#!/bin/sh
set -eu

umask 077
root=${OPENMUSE_ROOT:-/Volumes/p41-1tb/openmuse}
volume=/Volumes/p41-1tb
repo=$root/repo
env_file=$repo/.env
script_dir=$repo/infra/macos
node_dir=${OPENMUSE_NODE_DIR:-$root/runtime/node-current}

mount_point=$(/bin/df -P "$root" 2>/dev/null | /usr/bin/awk 'NR == 2 { print $6 }' || true)
if [ "$mount_point" != "$volume" ]; then
  echo "OpenMuse volume is not mounted at $volume; refusing to deploy to the system disk" >&2
  exit 75
fi
if [ "$(cd "$(dirname "$0")/../.." && pwd -P)" != "$repo" ]; then
  echo "Run this script from the checkout at $repo" >&2
  exit 78
fi

if [ ! -x "$node_dir/bin/node" ]; then
  echo "Set OPENMUSE_NODE_DIR to an unpacked official Node 24 directory under $root/runtime" >&2
  exit 69
fi
resolved_node_dir=$(cd "$node_dir" && pwd -P)
case "$resolved_node_dir" in
  "$root"/runtime/*) ;;
  *) echo "OPENMUSE_NODE_DIR must stay under $root/runtime" >&2; exit 78 ;;
esac
if [ "$resolved_node_dir" != "$root/runtime/node-current" ]; then
  /bin/ln -sfn "$resolved_node_dir" "$root/runtime/node-current"
fi
node=$root/runtime/node-current/bin/node
major=$($node -p 'Number(process.versions.node.split(".")[0])')
if [ "$major" -ne 24 ]; then
  echo "This deployment is pinned to Node 24; found major version $major" >&2
  exit 69
fi

/usr/bin/install -d -m 700 \
  "$root/data/app" \
  "$root/data/browser-profiles" \
  "$root/caches/corepack" \
  "$root/caches/pnpm" \
  "$root/caches/playwright" \
  "$root/logs"

if [ ! -f "$env_file" ]; then
  /usr/bin/install -m 600 "$script_dir/env.production.example" "$env_file"
  echo "Created $env_file with placeholders. Add the real credentials, then rerun deploy.sh." >&2
  exit 78
fi
/bin/chmod 600 "$env_file"

"$node" "$script_dir/validate-env.mjs" --env "$env_file" --root "$root" --infrastructure-only

corepack=$root/runtime/node-current/bin/corepack
if [ ! -x "$corepack" ]; then
  echo "The selected Node distribution does not include Corepack" >&2
  exit 69
fi
run_env() {
  allowed_names=$1
  shift
  "$node" "$script_dir/run-command.mjs" "$env_file" "$allowed_names" "$@"
}

cd "$repo"
COREPACK_HOME="$root/caches/corepack" PATH="$root/runtime/node-current/bin:$PATH" \
  "$corepack" pnpm install --frozen-lockfile --store-dir "$root/caches/pnpm"
COREPACK_HOME="$root/caches/corepack" PATH="$root/runtime/node-current/bin:$PATH" \
  "$corepack" pnpm build:server
COREPACK_HOME="$root/caches/corepack" PATH="$root/runtime/node-current/bin:$PATH" \
  run_env EXPO_PUBLIC_API_URL "$corepack" pnpm build:web
COREPACK_HOME="$root/caches/corepack" PATH="$root/runtime/node-current/bin:$PATH" \
  run_env PLAYWRIGHT_BROWSERS_PATH "$corepack" pnpm --dir apps/worker exec playwright install chromium

echo "Build complete. Run infra/macos/install-launch-agents.sh to install or refresh OpenMuse services."
