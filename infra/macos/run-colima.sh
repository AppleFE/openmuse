#!/bin/sh
set -eu
root=/Volumes/p41-1tb/openmuse
mount_point=$(/bin/df -P "$root" | /usr/bin/awk 'NR == 2 { print $6 }')
[ "$mount_point" = /Volumes/p41-1tb ] || { echo 'P41 is not mounted' >&2; exit 75; }
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export LIMA_HOME=$root/data/lima
exec /opt/homebrew/bin/colima start openmuse --foreground
