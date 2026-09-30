#!/bin/sh
set -eu

umask 077
root=/Volumes/p41-1tb/openmuse
volume=/Volumes/p41-1tb
version=0.34.4
archive=$root/runtime/ollama-download/Ollama-darwin.zip
checksum=f7ed834269e98929d9ed63d884c982287ec09d7ab6ee89587f90b9697a003ff1
runtime=$root/runtime/ollama
binary=$runtime/Ollama.app/Contents/Resources/ollama

mount_point=$(/bin/df -P "$root" 2>/dev/null | /usr/bin/awk 'NR == 2 { print $6 }' || true)
if [ "$mount_point" != "$volume" ]; then
  echo "OpenMuse volume is not mounted at $volume; refusing to install to the system disk" >&2
  exit 75
fi
if [ "$(cd "$(dirname "$0")/../.." && pwd -P)" != "$root/repo" ]; then
  echo "Run this script from the checkout at $root/repo" >&2
  exit 78
fi

/usr/bin/install -d -m 700 "$root/runtime/ollama-download" "$runtime"
if [ -x "$binary" ]; then
  version_output=$("$binary" --version 2>&1 || true)
  case "$version_output" in
    *"client version is $version"*)
      echo "Ollama CLI $version is already installed under $runtime"
      exit 0
      ;;
    *)
      echo "An unverified Ollama CLI already exists at $binary; inspect it before replacing" >&2
      exit 78
      ;;
  esac
fi

if [ ! -f "$archive" ] || [ "$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')" != "$checksum" ]; then
  temporary=$archive.$$
  trap '/bin/rm -f "$temporary"' EXIT HUP INT TERM
  /usr/bin/curl --fail --location --retry 3 --retry-delay 2 \
    --output "$temporary" \
    "https://github.com/ollama/ollama/releases/download/v$version/Ollama-darwin.zip"
  actual_checksum=$(/usr/bin/shasum -a 256 "$temporary" | /usr/bin/awk '{ print $1 }')
  if [ "$actual_checksum" != "$checksum" ]; then
    echo "Official Ollama archive checksum did not match the pinned release" >&2
    exit 78
  fi
  /bin/mv -f "$temporary" "$archive"
  trap - EXIT HUP INT TERM
fi

staging=$root/runtime/ollama-stage.$$
/usr/bin/install -d -m 700 "$staging"
cleanup() {
  /bin/rm -rf "$staging"
}
trap cleanup EXIT HUP INT TERM
/usr/bin/ditto -x -k "$archive" "$staging"
staged_binary=$staging/Ollama.app/Contents/Resources/ollama
if [ ! -x "$staged_binary" ]; then
  echo "Verified archive did not contain the expected Ollama app bundle" >&2
  exit 78
fi
version_output=$("$staged_binary" --version 2>&1 || true)
case "$version_output" in
  *"client version is $version"*) ;;
  *) echo "Ollama archive version check failed; refusing installation" >&2; exit 78 ;;
esac
architecture=$(/usr/bin/file "$staged_binary")
case "$architecture" in
  *arm64*) ;;
  *) echo "Ollama archive does not contain an Apple silicon executable" >&2; exit 78 ;;
esac

/bin/mv "$staging/Ollama.app" "$runtime/Ollama.app"
echo "Installed verified Ollama CLI $version under $runtime; the desktop app was not launched."
