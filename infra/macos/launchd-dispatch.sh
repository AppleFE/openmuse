#!/bin/sh
set -eu

umask 077
runner=/Volumes/p41-1tb/openmuse/repo/infra/macos/run-service.sh
logs=/Volumes/p41-1tb/openmuse/logs

case "${SSH_ORIGINAL_COMMAND:-}" in
  server|browser-worker|web) service=$SSH_ORIGINAL_COMMAND ;;
  *) echo "OpenMuse launch command denied" >&2; exit 64 ;;
esac

if [ ! -x "$runner" ]; then
  echo "OpenMuse runner is unavailable on P41" >&2
  exit 75
fi
/usr/bin/install -d -m 700 "$logs"
exec "$runner" "$service" >>"$logs/$service.out.log" 2>>"$logs/$service.err.log"
