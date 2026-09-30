#!/bin/sh
set -eu

umask 077
root=/Volumes/p41-1tb/openmuse
volume=/Volumes/p41-1tb
repo=$root/repo
source_dir=$repo/infra/macos
destination=$HOME/Library/LaunchAgents
domain=gui/$(/usr/bin/id -u)
ssh_dir=$HOME/.ssh
key=$ssh_dir/openmuse-launchd
known_hosts=$ssh_dir/openmuse-launchd-known-hosts
local_bin=$HOME/.local/libexec
dispatcher=$local_bin/openmuse-launchd
label=com.openmuse.ollama

[ "$HOME" = "/Users/aeonge" ] || { echo "These LaunchAgents target /Users/aeonge" >&2; exit 78; }
mount_point=$(/bin/df -P "$root" 2>/dev/null | /usr/bin/awk 'NR == 2 { print $6 }' || true)
if [ "$mount_point" != "$volume" ]; then
  echo "OpenMuse volume is not mounted at $volume; refusing to configure the system disk" >&2
  exit 75
fi
if [ "$(cd "$(dirname "$0")/../.." && pwd -P)" != "$repo" ]; then
  echo "Run this script from the checkout at $repo" >&2
  exit 78
fi
if [ ! -x "$root/runtime/ollama/Ollama.app/Contents/Resources/ollama" ]; then
  echo "Run infra/macos/install-ollama-runtime.sh before installing the LaunchAgent" >&2
  exit 78
fi
for required in "$key" "$known_hosts"; do
  if [ ! -f "$required" ]; then
    echo "The existing restricted OpenMuse launcher is not installed: $required" >&2
    echo "Install the OpenMuse LaunchAgents before adding the Ollama service." >&2
    exit 78
  fi
done

/usr/bin/install -d -m 700 \
  "$destination" \
  "$root/data/models/ollama" \
  "$root/data/ollama-home" \
  "$root/data/service-pids" \
  "$root/logs" \
  "$local_bin"
/usr/bin/install -m 700 "$source_dir/launchd-dispatch.sh" "$dispatcher"

restricted_ssh() {
  command=$1
  /usr/bin/ssh -T \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o ClearAllForwardings=yes \
    -o HostKeyAlgorithms=ssh-ed25519 \
    -o StrictHostKeyChecking=yes \
    -o ConnectTimeout=10 \
    -o ConnectionAttempts=1 \
    -o UserKnownHostsFile="$known_hosts" \
    -i "$key" \
    aeonge@127.0.0.1 "$command"
}

set +e
restricted_ssh invalid-command >/dev/null 2>&1
restriction_status=$?
set -e
if [ "$restriction_status" -ne 64 ]; then
  echo "Restricted localhost launcher self-test failed (status $restriction_status)" >&2
  exit 78
fi

source=$source_dir/launchd/com.openmuse.ollama.plist
target=$destination/com.openmuse.ollama.plist
/usr/bin/plutil -lint "$source" >/dev/null
/usr/bin/install -m 600 "$source" "$target"
/bin/launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
if ! restricted_ssh stop-ollama; then
  echo "Refusing to replace $label because its tracked process did not stop cleanly" >&2
  exit 75
fi
/bin/launchctl enable "$domain/$label"
/bin/launchctl bootstrap "$domain" "$target"
echo "Installed and started only com.openmuse.ollama."
