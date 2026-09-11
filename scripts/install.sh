#!/bin/sh
# Nexus desktop installer.
#
#   curl -fsSL https://raw.githubusercontent.com/hnaracodes/Nexus/main/scripts/install.sh | sh
#
# Detects your OS and CPU architecture, downloads the matching build from the
# latest GitHub release, VERIFIES ITS CHECKSUM against the one published
# alongside it in that same release, and refuses to install anything that
# doesn't match. It never installs an unverified file — a checksum mismatch
# is treated as a hard failure, not a warning.
#
# THE APP ITSELF IS UNSIGNED AND NOT NOTARIZED (CLAUDE.md §11: signing is a
# deferred decision, not an oversight). This script says so before it does
# anything, and again after installing, with the exact words each OS shows.
# It does not attempt to silently work around Gatekeeper or SmartScreen — see
# apps/web/src/pages/Download.tsx and USING.md for the fuller explanation of
# why disarming those checks by default would be the wrong default.
#
# Written in POSIX sh, not bash: `curl | sh` invokes the interpreter named on
# the command line, and on a stock Debian/Ubuntu box `sh` is dash, not bash.

set -eu

REPO="hnaracodes/Nexus"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RELEASES_PAGE="https://github.com/${REPO}/releases/latest"

log() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }
die() {
  err "$*"
  exit 1
}

# Overridable for tests (see scripts/install.test.mjs), which stub these on
# PATH rather than touching the real network or filesystem.
CURL="${NEXUS_INSTALL_CURL:-curl}"

fetch() {
  # $1 = url; prints the response body to stdout.
  "$CURL" -fsSL "$1"
}

download_to() {
  # $1 = url, $2 = destination path.
  "$CURL" -fsSL -o "$2" "$1"
}

sha256_of() {
  # $1 = path; prints the lowercase hex digest.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum is available on this machine to verify the download"
  fi
}

# ---- detect OS and architecture -------------------------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) platform=mac ;;
  Linux) platform=linux ;;
  *)
    die "This installer only supports macOS and Linux. On Windows, download the .exe directly: $RELEASES_PAGE"
    ;;
esac

case "$arch" in
  arm64 | aarch64) norm_arch=arm64 ;;
  x86_64 | amd64) norm_arch=x64 ;;
  *)
    die "Unrecognized CPU architecture '$arch'. Download a build manually from $RELEASES_PAGE"
    ;;
esac

log "Detected: $platform ($norm_arch)"
log "Checking the latest Nexus release..."
release_json="$(fetch "$API_URL")" ||
  die "Could not reach GitHub ($API_URL). Check your connection, or download manually: $RELEASES_PAGE"

# ---- find the matching asset and its published checksum --------------------
#
# No JSON parser here on purpose — GitHub's API returns one field per line
# (pretty-printed), so a plain grep/sed pipeline over "name" and
# "browser_download_url" lines is reliable and needs no dependency beyond
# curl itself. Every match is anchored to the end of the filename (right
# before the closing quote) specifically so a build's OWN checksum sidecar
# (e.g. "Nexus-1.2.3-mac-arm64.dmg.sha256") can never be mistaken for the
# build itself — a naive substring match on ".dmg" would hit both.
if [ "$platform" = "mac" ]; then
  asset_line="$(printf '%s\n' "$release_json" | grep -i '"name":' | grep -i '\.dmg"' | grep -i "$norm_arch" | head -n1)"
else
  asset_line="$(printf '%s\n' "$release_json" | grep -i '"name":' | grep -i '\.appimage"' | grep -i "$norm_arch" | head -n1)"
fi

if [ -z "$asset_line" ]; then
  die "No $platform/$norm_arch build was found in the latest release. See $RELEASES_PAGE"
fi
asset_name="$(printf '%s\n' "$asset_line" | sed -E 's/.*"name": *"([^"]+)".*/\1/')"

asset_url="$(printf '%s\n' "$release_json" | grep '"browser_download_url"' | grep -F "/${asset_name}\"" | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')"
if [ -z "$asset_url" ]; then
  die "Found '$asset_name' in the release but not its download URL — this looks like a bug in this script, please report it."
fi

checksum_name="${asset_name}.sha256"
checksum_url="$(printf '%s\n' "$release_json" | grep '"browser_download_url"' | grep -F "/${checksum_name}\"" | head -n1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')"
if [ -z "$checksum_url" ]; then
  die "The latest release has no published checksum for $asset_name. Refusing to install a build we cannot verify. See $RELEASES_PAGE"
fi

# ---- download and verify ----------------------------------------------------

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT INT TERM

asset_path="$workdir/$asset_name"
checksum_path="$workdir/$checksum_name"

log "Downloading $asset_name..."
download_to "$asset_url" "$asset_path" || die "Download failed: $asset_url"
download_to "$checksum_url" "$checksum_path" || die "Could not download the published checksum: $checksum_url"

expected="$(awk '{print $1}' "$checksum_path" | head -n1)"
if [ -z "$expected" ]; then
  die "The published checksum file for $asset_name is empty or malformed."
fi

actual="$(sha256_of "$asset_path")"

if [ "$expected" != "$actual" ]; then
  die "checksum mismatch for $asset_name
  expected: $expected
  actual:   $actual
Refusing to install a file that does not match its published checksum. This
could mean a corrupted download, or something worse — do not retry blindly."
fi

log "Checksum verified."

# ---- install -----------------------------------------------------------

if [ "$platform" = "mac" ]; then
  mount_point="$(mktemp -d)"
  if ! hdiutil attach "$asset_path" -nobrowse -quiet -mountpoint "$mount_point"; then
    rmdir "$mount_point" 2>/dev/null || true
    die "Could not mount the downloaded disk image. Open it manually from $asset_path"
  fi

  app_path=""
  for candidate in "$mount_point"/*.app; do
    if [ -d "$candidate" ]; then
      app_path="$candidate"
      break
    fi
  done

  if [ -z "$app_path" ]; then
    hdiutil detach "$mount_point" -quiet || true
    die "Could not find Nexus.app inside the downloaded disk image."
  fi

  apps_dir="${NEXUS_INSTALL_APPLICATIONS_DIR:-/Applications}"
  mkdir -p "$apps_dir"
  dest="$apps_dir/Nexus.app"
  rm -rf "$dest"
  cp -R "$app_path" "$dest"
  hdiutil detach "$mount_point" -quiet || true

  log ""
  log "Installed Nexus.app to $dest"
  log ""
  log "IMPORTANT: this build is unsigned and not notarized."
  log "The first time you open it, macOS will say:"
  log "  \"Apple could not verify that 'Nexus' is free of malware.\""
  log "Do not move it to the Trash. Instead:"
  log "  1. Open Finder and go to Applications."
  log "  2. Right-click (or Control-click) Nexus.app."
  log "  3. Choose Open, then click Open again in the dialog that appears."
  log "You only need to do this once."
  log ""
  log "Advanced / last resort, only if that still refuses: you can remove the"
  log "quarantine flag Gatekeeper checks for:"
  log "  xattr -d com.apple.quarantine \"$dest\""
  log "This disables the malware check for Nexus specifically — only do this"
  log "if you trust where you got the file. It is not the recommended step;"
  log "the right-click instruction above is."
else
  bin_dir="${NEXUS_INSTALL_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin_dir"
  dest="$bin_dir/Nexus.AppImage"
  cp "$asset_path" "$dest"
  chmod +x "$dest"

  log ""
  log "Installed to $dest"
  log "Run it with: $dest"
  log ""
  log "This build is unsigned. AppImage has no code-signing step of its own,"
  log "so there is no Gatekeeper- or SmartScreen-style warning to expect here"
  log "— but it is still worth knowing nobody has cryptographically signed it."
  case ":${PATH}:" in
    *":$bin_dir:"*) ;;
    *) log "Note: $bin_dir is not on your PATH." ;;
  esac
fi
