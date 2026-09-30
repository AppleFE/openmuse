#!/bin/sh
set -eu

umask 077
root=/Volumes/p41-1tb/openmuse
runner=/Volumes/p41-1tb/openmuse/repo/infra/macos/run-service.sh
logs=/Volumes/p41-1tb/openmuse/logs
pids=/Volumes/p41-1tb/openmuse/data/service-pids
node=/Volumes/p41-1tb/openmuse/runtime/node-current/bin/node

case "${SSH_ORIGINAL_COMMAND:-}" in
  server|browser-worker|web|ollama) action=start; service=$SSH_ORIGINAL_COMMAND ;;
  stop-server) action=stop; service=server ;;
  stop-browser-worker) action=stop; service=browser-worker ;;
  stop-web) action=stop; service=web ;;
  stop-ollama) action=stop; service=ollama ;;
  *) echo "OpenMuse launch command denied" >&2; exit 64 ;;
esac

pid_file=$pids/$service.pid

is_owned_process() {
  candidate_pid=$1
  candidate_user=$(/bin/ps -p "$candidate_pid" -o user= 2>/dev/null | /usr/bin/tr -d '[:space:]' || true)
  candidate_command=$(/bin/ps -p "$candidate_pid" -o command= 2>/dev/null || true)
  [ "$candidate_user" = aeonge ] || return 1
  case "$service:$candidate_command" in
    "server:$node --env-file=$root/repo/.env dist/apps/server/src/index.js") return 0 ;;
    "browser-worker:$node --env-file=$root/repo/.env --experimental-strip-types apps/worker/src/index.ts") return 0 ;;
    "web:$node --env-file=$root/repo/.env infra/macos/serve-web.mjs") return 0 ;;
    "ollama:$root/runtime/ollama/Ollama.app/Contents/Resources/ollama serve") return 0 ;;
    *) return 1 ;;
  esac
}

process_exists() {
  [ -n "$(/bin/ps -p "$1" -o pid= 2>/dev/null | /usr/bin/tr -d '[:space:]' || true)" ]
}

read_pid() {
  [ -f "$pid_file" ] || return 1
  tracked_pid=$(/bin/cat "$pid_file")
  case "$tracked_pid" in
    ''|*[!0-9]*) echo "Invalid OpenMuse PID file: $pid_file" >&2; exit 78 ;;
  esac
}

if [ "$action" = stop ]; then
  read_pid || exit 0
  if ! process_exists "$tracked_pid"; then
    /bin/rm -f "$pid_file"
    exit 0
  fi
  if ! is_owned_process "$tracked_pid"; then
    echo "Refusing to stop PID $tracked_pid because it is not the tracked $service process" >&2
    exit 77
  fi
  /bin/kill -TERM "$tracked_pid"
  attempt=0
  while process_exists "$tracked_pid" && [ "$attempt" -lt 20 ]; do
    attempt=$((attempt + 1))
    /bin/sleep 1
  done
  if process_exists "$tracked_pid"; then
    echo "Tracked $service process $tracked_pid did not stop within 20 seconds" >&2
    exit 75
  fi
  /bin/rm -f "$pid_file"
  exit 0
fi

if [ ! -x "$runner" ]; then
  echo "OpenMuse runner is unavailable on P41" >&2
  exit 75
fi
/usr/bin/install -d -m 700 "$logs" "$pids"
if read_pid && process_exists "$tracked_pid"; then
  if is_owned_process "$tracked_pid"; then
    echo "Tracked $service process $tracked_pid is already running" >&2
    exit 75
  fi
  echo "Refusing to replace PID file for an unrecognized live process: $pid_file" >&2
  exit 77
fi
pid_temp=$pid_file.$$
"$runner" "$service" >>"$logs/$service.out.log" 2>>"$logs/$service.err.log" &
started_pid=$!
/usr/bin/printf '%s\n' "$started_pid" >"$pid_temp"
/bin/chmod 600 "$pid_temp"
/bin/mv -f "$pid_temp" "$pid_file"
set +e
wait "$started_pid"
service_status=$?
set -e
if read_pid && [ "$tracked_pid" = "$started_pid" ]; then
  /bin/rm -f "$pid_file"
fi
exit "$service_status"
