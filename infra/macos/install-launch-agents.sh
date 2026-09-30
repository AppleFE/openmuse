#!/bin/sh
set -eu

umask 077
root=/Volumes/p41-1tb/openmuse
repo=$root/repo
source_dir=$repo/infra/macos/launchd
destination=$HOME/Library/LaunchAgents
domain=gui/$(/usr/bin/id -u)
node=$root/runtime/node-current/bin/node
ssh_dir=$HOME/.ssh
key=$ssh_dir/openmuse-launchd
known_hosts=$ssh_dir/openmuse-launchd-known-hosts
authorized_keys=$ssh_dir/authorized_keys
local_bin=$HOME/.local/libexec
dispatcher=$local_bin/openmuse-launchd
key_tag=openmuse-launchd@localhost

[ "$HOME" = "/Users/aeonge" ] || { echo "These launchd files target /Users/aeonge" >&2; exit 78; }
"$node" "$repo/infra/macos/validate-env.mjs" --env "$repo/.env" --root "$root" --infrastructure-only
set +e
"$node" "$repo/infra/macos/validate-env.mjs" --env "$repo/.env" --root "$root"
api_ready=$?
set -e
/usr/bin/install -d -m 700 "$destination" "$root/logs" "$ssh_dir" "$local_bin"
/usr/bin/install -m 700 "$repo/infra/macos/launchd-dispatch.sh" "$dispatcher"

if [ ! -f "$key" ]; then
  /usr/bin/ssh-keygen -q -t ed25519 -N '' -C "$key_tag" -f "$key"
fi
/bin/chmod 600 "$key"
if [ ! -f "$key.pub" ]; then
  public_material=$(/usr/bin/ssh-keygen -y -f "$key")
  /usr/bin/printf '%s %s\n' "$public_material" "$key_tag" >"$key.pub"
fi
/bin/chmod 644 "$key.pub"

known_hosts_temp=$(/usr/bin/mktemp "$ssh_dir/openmuse-known-hosts.XXXXXX")
authorized_temp=$(/usr/bin/mktemp "$ssh_dir/authorized-keys.XXXXXX")
cleanup() {
  /bin/rm -f "$known_hosts_temp" "$authorized_temp"
}
trap cleanup EXIT HUP INT TERM
/usr/bin/ssh-keyscan -t ed25519 127.0.0.1 localhost >"$known_hosts_temp" 2>/dev/null
if [ ! -s "$known_hosts_temp" ]; then
  echo "Could not read the localhost SSH host key" >&2
  exit 69
fi
/bin/chmod 600 "$known_hosts_temp"
/bin/mv -f "$known_hosts_temp" "$known_hosts"

if [ -f "$authorized_keys" ]; then
  /usr/bin/grep -vF "$key_tag" "$authorized_keys" >"$authorized_temp" || true
fi
public_key=$(/bin/cat "$key.pub")
/usr/bin/printf '%s %s\n' \
  'restrict,from="127.0.0.1",command="/Users/aeonge/.local/libexec/openmuse-launchd"' \
  "$public_key" >>"$authorized_temp"
/bin/chmod 600 "$authorized_temp"
/bin/mv -f "$authorized_temp" "$authorized_keys"

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

stop_loaded_service() {
  label=$1
  service=${label#com.openmuse.}
  /bin/launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  if ! restricted_ssh "stop-$service"; then
    echo "Refusing to replace $label because its tracked process did not stop cleanly" >&2
    exit 75
  fi
}

set +e
restricted_ssh invalid-command >/dev/null 2>&1
restriction_status=$?
set -e
if [ "$restriction_status" -ne 64 ]; then
  echo "Restricted localhost launcher self-test failed (status $restriction_status)" >&2
  exit 78
fi

labels="com.openmuse.browser-worker com.openmuse.web"
if [ "$api_ready" -eq 0 ]; then
  labels="com.openmuse.server $labels"
else
  stop_loaded_service com.openmuse.server
  /bin/rm -f "$destination/com.openmuse.server.plist"
  echo "API LaunchAgent was not installed because genuine CPK/model credentials are incomplete." >&2
fi

for label in $labels; do
  source=$source_dir/$label.plist
  target=$destination/$label.plist
  /usr/bin/plutil -lint "$source" >/dev/null
  /usr/bin/install -m 600 "$source" "$target"
  stop_loaded_service "$label"
  /bin/launchctl enable "$domain/$label"
  /bin/launchctl bootstrap "$domain" "$target"
done

echo "Installed and started only the credential-ready com.openmuse.* LaunchAgents."
