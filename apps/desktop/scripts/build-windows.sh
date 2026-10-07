#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
desktop="$root/apps/desktop"
target=x86_64-pc-windows-msvc
release="$desktop/src-tauri/target/$target/release"
out="$root/dist-windows"
exe="ai-quota.exe"

for cmd in npm bun cargo-xwin; do
  command -v "$cmd" >/dev/null || { echo "missing command: $cmd" >&2; exit 1; }
done
rustup target list --installed | grep -qx "$target" || rustup target add "$target"

TAURI_ENV_TARGET_TRIPLE="$target" STATIC_VCRUNTIME=true npm --prefix "$desktop" run tauri -- build \
  --runner cargo-xwin --target "$target" --no-bundle

rm -rf "$out"
mkdir -p "$out" || test -d "$out"
install -m 0755 "$release/ai-quota-desktop.exe" "$out/$exe"
install -m 0755 "$desktop/src-tauri/binaries/ai-quota-worker-$target.exe" "$out/ai-quota-worker.exe"
sha256sum "$out/$exe"
