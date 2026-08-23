#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
desktop="$root/apps/desktop"
target=x86_64-pc-windows-gnu
toolchain=x86_64-w64-mingw32
release="$desktop/src-tauri/target/$target/release"
out="$root/dist-windows"
version=$(node -p "require('$desktop/package.json').version")
exe="ai-quota-$version-windows-x64.exe"

for cmd in npm node "$toolchain-gcc" "$toolchain-ar" zip; do
  command -v "$cmd" >/dev/null || { echo "missing command: $cmd" >&2; exit 1; }
done
rustup target list --installed | grep -qx "$target" || rustup target add "$target"

env -u CFLAGS -u CXXFLAGS -u RANLIB \
  CC_x86_64_pc_windows_gnu="$toolchain-gcc" \
  CXX_x86_64_pc_windows_gnu="$toolchain-g++" \
  AR_x86_64_pc_windows_gnu="$toolchain-ar" \
  npm --prefix "$desktop" run tauri -- build --target "$target" --no-bundle

mkdir -p "$out"
install -m 0755 "$release/ai-quota-desktop.exe" "$out/$exe"
install -m 0644 "$release/WebView2Loader.dll" "$out/WebView2Loader.dll"
rm -f "$out/${exe%.exe}.zip"
(cd "$out" && zip -q "${exe%.exe}.zip" "$exe" WebView2Loader.dll)
sha256sum "$out/$exe" "$out/${exe%.exe}.zip"
