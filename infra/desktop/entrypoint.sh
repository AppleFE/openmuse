#!/bin/sh
set -eu
touch "$HOME/.Xauthority"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
i=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -lt 50 ] || exit 1; sleep 0.1
done
openbox >/tmp/openbox.log 2>&1 &
xterm -geometry 90x28+40+40 -title 'OpenMuse virtual desktop' -xrm 'XTerm*VT100.translations: #override Ctrl Shift<Key>V: insert-selection(CLIPBOARD)' >/tmp/xterm.log 2>&1 &
exec python -u /opt/openmuse/driver.py
