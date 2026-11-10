#!/bin/sh
set -eu

repository=Camil-H/spyria
version=${SPYRIA_VERSION:-latest}
install_dir=${SPYRIA_INSTALL_DIR:-$HOME/.local/bin}
download_base=${SPYRIA_DOWNLOAD_BASE:-https://github.com/$repository/releases}

fail() {
  echo "spyria: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "Spyria installs on Linux or macOS; on Windows, run this inside WSL." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no Spyria build for $(uname -m)" ;;
esac

ask() {
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=
  [ "$answer" = y ] || [ "$answer" = Y ]
}

if ! command -v docker >/dev/null 2>&1; then
  if [ "$os" = darwin ]; then
    fail "Docker is missing: install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack (https://orbstack.dev), start it, then run this again."
  fi
  ask "Docker is missing. Install Docker Engine with Docker's own script (https://get.docker.com)?" ||
    fail "Docker is required: install it, then run this again."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing: install the Docker Compose plugin, then run this again."
if ! docker info >/dev/null 2>&1; then
  if [ "$os" = linux ] && [ -S /var/run/docker.sock ] && ! [ -w /var/run/docker.sock ]; then
    fail "Docker does not let you in yet: run sudo usermod -aG docker $(id -un), log out and back in, then run this again."
  fi
  fail "Docker does not answer: start it, then run this again."
fi

if [ "$version" = latest ]; then
  release_path=latest/download
else
  release_path=download/v$version
fi
binary=spyria-$os-$arch
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "$download_base/$release_path/$binary" -o "$work/$binary"
curl -fsSL "$download_base/$release_path/spyria-checksums.txt" -o "$work/checksums.txt"
expected=$(grep " $binary\$" "$work/checksums.txt" | cut -d ' ' -f 1)
[ -n "$expected" ] || fail "the release lists no checksum for $binary"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$binary" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$work/$binary" | cut -d ' ' -f 1)
fi
[ "$actual" = "$expected" ] || fail "the download of $binary does not match its checksum"

mkdir -p "$install_dir"
install -m 755 "$work/$binary" "$install_dir/spyria"
echo "Installed spyria in $install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH to run spyria from anywhere." ;;
esac

[ "${SPYRIA_SKIP_SETUP:-}" = 1 ] && exit 0
if ! (: </dev/tty) 2>/dev/null; then
  echo "No terminal to ask the setup questions: run spyria setup, or spyria setup --unattended with its flags (spyria --help)."
  exit 0
fi
exec "$install_dir/spyria" setup </dev/tty
