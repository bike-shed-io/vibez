#!/usr/bin/env bash
# Build a pacman package from the working tree. No network, sudo, npm install, or CI.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux ]] || ! command -v makepkg >/dev/null; then
  echo 'Run this on Arch/EndeavourOS/Omarchy with base-devel, nodejs, and python installed.' >&2
  exit 1
fi
output="${1:-$root/dist/linux}"
mkdir -p "$output"
output="$(cd -- "$output" && pwd)"
staging="$(mktemp -d "${TMPDIR:-/tmp}/vibez-arch.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
version="$(node -p 'require(process.argv[1]).version' "$root/linux/package.json")"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct 2>/dev/null || date +%s)}"
python3 - "$root" "$staging" "$version" <<'PY'
import gzip, hashlib, os, pathlib, sys, tarfile
root, staging, version = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
archive = staging / f"vibez-desktop-{version}.tar.gz"
epoch = int(os.environ["SOURCE_DATE_EPOCH"])
def normalize(info):
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = epoch
    return info
with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=epoch) as compressed:
    with tarfile.open(fileobj=compressed, mode="w") as tar:
        for entry in sorted((root / "linux").rglob("*")):
            if entry.is_file() and "node_modules" not in entry.parts:
                tar.add(entry, arcname=f"vibez-desktop-{version}/{entry.relative_to(root / 'linux')}", filter=normalize)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
recipe = (root / "pkg/arch/PKGBUILD").read_text().replace("@SOURCE_SHA256@", checksum)
recipe = recipe.replace("pkgver=0.1.0", f"pkgver={version}")
(staging / "PKGBUILD").write_text(recipe)
PY
cd -- "$staging"
# The payload is platform-independent JS; Electron is only needed at runtime.
# Node executes check(), so --nodeps does not skip the client tests.
makepkg --nodeps --cleanbuild --noconfirm
makepkg --printsrcinfo > .SRCINFO
cp -- ./*.pkg.tar.zst ./*.tar.gz PKGBUILD .SRCINFO "$output/"
cd -- "$output"
sha256sum -- ./*.pkg.tar.zst > SHA256SUMS
printf '\nPackage ready in %s\nInstall with: sudo pacman -U %s/vibez-desktop-%s-1-any.pkg.tar.zst\n' "$output" "$output" "$version"
