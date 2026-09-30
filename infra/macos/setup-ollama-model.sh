#!/bin/sh
set -eu

umask 077
root=/Volumes/p41-1tb/openmuse
volume=/Volumes/p41-1tb
model=qwen3:4b
binary=$root/runtime/ollama/Ollama.app/Contents/Resources/ollama
state=$root/data/ollama-home
models=$root/data/models/ollama

mount_point=$(/bin/df -P "$root" 2>/dev/null | /usr/bin/awk 'NR == 2 { print $6 }' || true)
if [ "$mount_point" != "$volume" ]; then
  echo "OpenMuse volume is not mounted at $volume; refusing to download outside P41" >&2
  exit 75
fi
if [ "$(cd "$(dirname "$0")/../.." && pwd -P)" != "$root/repo" ]; then
  echo "Run this script from the checkout at $root/repo" >&2
  exit 78
fi
if [ ! -x "$binary" ]; then
  echo "Run infra/macos/install-ollama-runtime.sh first" >&2
  exit 78
fi

/usr/bin/install -d -m 700 "$state" "$models"
/usr/bin/curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:11434/api/tags >/dev/null || {
  echo "The local Ollama service is not listening at 127.0.0.1:11434" >&2
  exit 69
}

/usr/bin/env \
  HOME="$state" \
  OLLAMA_HOST=127.0.0.1:11434 \
  OLLAMA_MODELS="$models" \
  OLLAMA_NO_CLOUD=1 \
  "$binary" pull "$model"

/usr/bin/env HOME="$state" OLLAMA_HOST=127.0.0.1:11434 \
  OLLAMA_MODELS="$models" "$binary" list |
  /usr/bin/awk -v expected="$model" 'NR > 1 && $1 == expected { found = 1 } END { exit !found }' || {
  echo "The local Ollama model $model was not confirmed after download" >&2
  exit 69
}
echo "Verified local model $model under $models"
