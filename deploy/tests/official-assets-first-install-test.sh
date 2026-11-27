#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
export AID_SH_LIBRARY_MODE=1 AID_DATA_ROOT="$sandbox/data"
source "$repo/deploy/aid.sh"

mkdir -p "$DATA_ROOT/uploadPath"
calls="$sandbox/downloads"
database_query() {
  printf '%s\n' "$storage"
}

storage=cos
offer_official_assets_import none </dev/null > "$sandbox/message"
grep -q '手动上传资源包' "$sandbox/message"

storage=local
AID_ASSUME_YES=1 offer_official_assets_import none </dev/null > "$sandbox/message"
grep -q '安装已完成' "$sandbox/message"
AID_IMPORT_OFFICIAL_ASSETS=y offer_official_assets_import docker </dev/null > "$sandbox/message"
[[ ! -s "$sandbox/message" ]]

curl() {
  printf 'attempt\n' >> "$calls"
  return 22
}
AID_IMPORT_OFFICIAL_ASSETS=n AID_ASSUME_YES=1 offer_official_assets_import none </dev/null > "$sandbox/message"
[[ ! -e "$calls" ]]
AID_IMPORT_OFFICIAL_ASSETS=y AID_ASSUME_YES=1 offer_official_assets_import none </dev/null > "$sandbox/message"
grep -q '官方资源包自动导入失败.*手动导入' "$sandbox/message"
[[ "$(wc -l < "$calls")" -eq 1 ]]
[[ ! -e "$DATA_ROOT/uploadPath/aid" ]]
[[ -z "$(find "$DATA_ROOT/uploadPath" -maxdepth 1 -name '.official-assets.*' -print -quit)" ]]

mkdir -p "$DATA_ROOT/uploadPath/aid"
printf 'keep\n' > "$DATA_ROOT/uploadPath/aid/existing"
import_official_assets_locally
[[ "$(wc -l < "$calls")" -eq 1 ]]
grep -Fxq 'keep' "$DATA_ROOT/uploadPath/aid/existing"

archiveRoot="${OFFICIAL_ASSETS_ARCHIVE%.tar.gz}"
fixture="$sandbox/fixture/$archiveRoot"
mkdir -p "$fixture/files/aid/voice"
printf 'sample bytes\n' > "$fixture/files/aid/voice/sample.mp3"
(
  cd "$fixture"
  sha256sum files/aid/voice/sample.mp3 | sed 's/$/\r/' > asset-checksums.txt
)
pack_fixture() {
  tar --create --gzip --file "$sandbox/download.tar.gz" --directory "$sandbox/fixture" "$archiveRoot"
  OFFICIAL_ASSETS_SHA256="$(sha256_file "$sandbox/download.tar.gz")"
}
curl() {
  while (($#)); do
    if [[ "$1" == --output ]]; then
      cp "$sandbox/download.tar.gz" "$2"
      return
    fi
    shift
  done
  return 1
}
pack_fixture
DATA_ROOT="$sandbox/crlf"
mkdir -p "$DATA_ROOT/uploadPath"
AID_IMPORT_OFFICIAL_ASSETS=y AID_ASSUME_YES=1 offer_official_assets_import none </dev/null > "$sandbox/message"
cmp "$fixture/files/aid/voice/sample.mp3" "$DATA_ROOT/uploadPath/aid/voice/sample.mp3"
grep -q '官方资源包已导入本地存储' "$sandbox/message"

# 整包摘要合法也不能跳过文件级校验。
printf 'changed bytes\n' > "$fixture/files/aid/voice/sample.mp3"
pack_fixture
DATA_ROOT="$sandbox/corrupt"
mkdir -p "$DATA_ROOT/uploadPath"
AID_IMPORT_OFFICIAL_ASSETS=y AID_ASSUME_YES=1 offer_official_assets_import none </dev/null > "$sandbox/message"
grep -q '官方资源包自动导入失败.*手动导入' "$sandbox/message"
[[ ! -e "$DATA_ROOT/uploadPath/aid" ]]

printf 'official first-install asset tests passed\n'
