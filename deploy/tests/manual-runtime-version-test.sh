#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "${TMP_ROOT}"' EXIT

export AID_SH_LIBRARY_MODE=1
export AID_DATA_ROOT="${TMP_ROOT}/data/aid"
export AID_JAVA_PROFILE_FILE="${TMP_ROOT}/profile.d/aid-java.sh"
# shellcheck source=../aid.sh
source "${ROOT_DIR}/deploy/aid.sh"
unset AID_JDK_DOWNLOAD_URL AID_MANUAL_JDK_DOWNLOAD_URL

(
  oracle_fingerprint=859BE8D7C586F538430B19C2467B942D3A79BD29
  name=mysql-5.7.44-linux-glibc2.12-x86_64.tar.gz
  fixture_hash=798ff0a14cdc1ab259f8a3b6a7f683403e9bbaa85957d82e5370f82b27ba6805
  fixture_revoked=no
  sha256_file() { printf '%s\n' "$fixture_hash"; }
  gpg() {
    if [[ "$*" == *'--faked-system-time 1697201558'* ]]; then
      printf '%s\n' "[GNUPG:] VALIDSIG $oracle_fingerprint 2023-10-12 1697115158 0 4 0 1 8 00 $oracle_fingerprint"
      return
    fi
    printf '%s\n' '[GNUPG:] KEYEXPIRED 1702568375' "[GNUPG:] KEY_CONSIDERED $oracle_fingerprint 1" \
      "[GNUPG:] ERRSIG 467B942D3A79BD29 1 8 00 1697115158 9 $oracle_fingerprint" \
      '[GNUPG:] NO_PUBKEY 467B942D3A79BD29'
    if [[ "$fixture_revoked" == yes ]]; then printf '%s\n' '[GNUPG:] REVKEYSIG 467B942D3A79BD29 MySQL'; fi
    return 2
  }
  verify_mysql_signature_at_release "$TMP_ROOT" signature archive "$name" "$oracle_fingerprint"
  fixture_revoked=yes
  if verify_mysql_signature_at_release "$TMP_ROOT" signature archive "$name" "$oracle_fingerprint"; then
    echo 'FAIL: historical validation accepted a revoked key' >&2; exit 1
  fi
  fixture_revoked=no
  fixture_hash=wrong
  if verify_mysql_signature_at_release "$TMP_ROOT" signature archive "$name" "$oracle_fingerprint"; then
    echo 'FAIL: historical validation accepted an unpinned archive' >&2; exit 1
  fi
)

[[ "${NGINX_VERSION}" == "1.30.4" ]] || { echo 'FAIL: manual Nginx version drifted' >&2; exit 1; }
[[ "${MYSQL_VERSION}" == "5.7.44" ]] || { echo 'FAIL: manual MySQL version drifted' >&2; exit 1; }
[[ "${REDIS_VERSION}" == "8.0.5" ]] || { echo 'FAIL: manual Redis version drifted' >&2; exit 1; }
[[ "${MANUAL_JDK_VERSION}" == "17.0.8" && "${JDK_VERSION}" == "17.0.8" ]] \
  || { echo 'FAIL: Docker and manual JDK versions must both be 17.0.8' >&2; exit 1; }
[[ "${JAVA_RUNTIME_IMAGE}" == "aid/openjdk:17.0.8-ffmpeg8.1.2-font2.004" ]] \
  || { echo 'FAIL: Docker JDK image tag drifted' >&2; exit 1; }
[[ "${FFMPEG_RUNTIME_VERSION}" == "8.1.2" && "${FFMPEG_MIN_VERSION}" == "5.1" ]] \
  || { echo 'FAIL: FFmpeg fixed runtime baseline drifted' >&2; exit 1; }
[[ "${FFMPEG_RUNTIME_MIRROR_TAG}" == "v1.0.0-beta.6" ]] \
  || { echo 'FAIL: FFmpeg domestic mirror release drifted' >&2; exit 1; }
unset AID_FFMPEG_PRIMARY_URL_AMD64 AID_FFMPEG_TENCENT_URL_AMD64 AID_FFMPEG_ALIYUN_URL_AMD64
unset AID_FFMPEG_PRIMARY_URL_ARM64 AID_FFMPEG_TENCENT_URL_ARM64 AID_FFMPEG_ALIYUN_URL_ARM64
for arch in amd64 arm64; do
  archive_name="ffmpeg-8.1.2-${arch}-static.tar.xz"
  mapfile -t ffmpeg_urls < <(ffmpeg_runtime_download_urls "${arch}")
  [[ "${#ffmpeg_urls[@]}" -eq 3 \
    && "${ffmpeg_urls[0]}" == "https://api.atomgit.com/api/v5/repos/shijue-aid/aid-studio/releases/v3.0.0/attach_files/${archive_name}/download" \
    && "${ffmpeg_urls[1]}" == "https://cdn.aidstudio.com.cn/aid/release/ffmpeg/8.1.2/${archive_name}" \
    && "${ffmpeg_urls[2]}" == "https://github.com/shijue-aid/aid-studio/releases/download/v1.0.0-beta.6/${archive_name}" ]] \
    || { echo "FAIL: FFmpeg ${arch} default order must be AtomGit, AID CDN, GitHub" >&2; exit 1; }
done
AID_FFMPEG_PRIMARY_URL_AMD64="$(ffmpeg_runtime_atomgit_url amd64)"
AID_FFMPEG_TENCENT_URL_AMD64='https://cdn.aidstudio.com.cn/aid/release/ffmpeg/8.1.2/ffmpeg-8.1.2-amd64-static.tar.xz'
mapfile -t ffmpeg_urls < <(ffmpeg_runtime_download_urls amd64)
[[ "${#ffmpeg_urls[@]}" -eq 3 ]] \
  || { echo 'FAIL: duplicate FFmpeg mirror URLs must be attempted only once' >&2; exit 1; }
unset AID_FFMPEG_PRIMARY_URL_AMD64 AID_FFMPEG_TENCENT_URL_AMD64
(
  FFMPEG_RUNTIME_ROOT="${TMP_ROOT}/ffmpeg-fallback"
  try_download() {
    printf '%s\n' "$1" >> "${TMP_ROOT}/ffmpeg-download-order"
    case "$1" in
      https://cdn.aidstudio.com.cn/*) printf '%s\n' 'corrupted CDN payload' > "$2" ;;
      *) return 1 ;;
    esac
  }
  if install_ffmpeg_runtime_version amd64 "$(ffmpeg_runtime_checksum amd64)"; then
    echo 'FAIL: FFmpeg accepted a corrupted fallback archive' >&2; exit 1
  fi
  diff -u <(ffmpeg_runtime_download_urls amd64) "${TMP_ROOT}/ffmpeg-download-order" \
    || { echo 'FAIL: FFmpeg did not fall back after download or SHA256 failure' >&2; exit 1; }
)
! sed -n '/install_ffmpeg_runtime_version()/,/^)/p' "${ROOT_DIR}/deploy/aid.sh" | grep -q 'rank_download_urls' \
  || { echo 'FAIL: FFmpeg installer must preserve configured mirror priority' >&2; exit 1; }
configure_ffmpeg_runtime_paths
[[ "${FFMPEG_RUNTIME_FFMPEG}" == '/opt/aid-ffmpeg/current/ffmpeg' \
   && "${FFMPEG_RUNTIME_FFPROBE}" == '/opt/aid-ffmpeg/current/ffprobe' ]] \
  || { echo 'FAIL: FFmpeg managed paths must be identical across deployment modes' >&2; exit 1; }
[[ "${AID_CJK_FONT_VERSION}" == 'noto-sans-sc-2.004' \
   && "${AID_CJK_FONT_PATH}" == '/opt/aid-fonts/current/aid-cjk-font' \
   && "${AID_CJK_FONT_SHA256}" == '4d107c09ada479d3e48b6e78c83835773cbd9214bf6e12cdb7b60f8e068292ec' \
   && "${AID_CJK_FONT_FILE_SHA256}" == 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9' ]] \
  || { echo 'FAIL: managed CJK font baseline drifted' >&2; exit 1; }
[[ "$(ffmpeg_runtime_checksum amd64)" == '7ea38eeee6b391a10ff01d72b75a303db125b0e5ed26cb0d8a2704445f59f0da' \
   && "$(ffmpeg_runtime_checksum arm64)" == 'd75b8a5dbafda1e819775af556df312e84902a47e84addbbcd91891a5c606951' ]] \
  || { echo 'FAIL: FFmpeg architecture checksum drifted' >&2; exit 1; }
grep -Fq 'image: aid/openjdk:17.0.8-ffmpeg8.1.2-font2.004' "${ROOT_DIR}/deploy/docker/docker-compose.yml" \
  || { echo 'FAIL: Compose FFmpeg image tag drifted' >&2; exit 1; }
grep -Fq 'JDK_VERSION="17.0.8"' "${ROOT_DIR}/deploy/build-release-from-source.sh" \
  || { echo 'FAIL: source builder JDK version drifted' >&2; exit 1; }
grep -Fq 'JDK_BT_MIRROR_NODES="https://download-cdn1.bt.cn' "${ROOT_DIR}/deploy/build-release-from-source.sh" \
  || { echo 'FAIL: source builder must prefer the fixed AID domestic JDK mirror' >&2; exit 1; }
grep -Fq 'https://download.oracle.com/java/17/archive/jdk-${JDK_VERSION}_linux-${jdk_oracle_arch}_bin.tar.gz' \
  "${ROOT_DIR}/deploy/build-release-from-source.sh" \
  || { echo 'FAIL: source builder lacks the Oracle JDK fallback' >&2; exit 1; }
grep -Fq 'AID_FFMPEG_PATH: /opt/aid-ffmpeg/current/ffmpeg' "${ROOT_DIR}/deploy/docker/docker-compose.yml" \
  || { echo 'FAIL: Compose FFmpeg path drifted' >&2; exit 1; }
grep -Fq 'AID_FFPROBE_PATH: /opt/aid-ffmpeg/current/ffprobe' "${ROOT_DIR}/deploy/docker/docker-compose.yml" \
  || { echo 'FAIL: Compose FFprobe path drifted' >&2; exit 1; }
grep -Fq "'ffmpegPath', '/opt/aid-ffmpeg/current/ffmpeg'" "${ROOT_DIR}/sql/aid-init.sql" \
  || { echo 'FAIL: aid-init FFmpeg default path drifted' >&2; exit 1; }
grep -Fq "'ffprobePath', '/opt/aid-ffmpeg/current/ffprobe'" "${ROOT_DIR}/sql/aid-init.sql" \
  || { echo 'FAIL: aid-init FFprobe default path drifted' >&2; exit 1; }
grep -Fq "'ffmpegPath', '/opt/aid-ffmpeg/current/ffmpeg'" "${ROOT_DIR}/sql/v1.0.0-beta.6.sql" \
  || { echo 'FAIL: beta.6 FFmpeg default path drifted' >&2; exit 1; }
grep -Fq "'ffprobePath', '/opt/aid-ffmpeg/current/ffprobe'" "${ROOT_DIR}/sql/v1.0.0-beta.6.sql" \
  || { echo 'FAIL: beta.6 FFprobe default path drifted' >&2; exit 1; }
grep -Fq "'ffmpegFontFile', '/opt/aid-fonts/current/aid-cjk-font'" "${ROOT_DIR}/sql/aid-init.sql" \
  || { echo 'FAIL: aid-init CJK font default path drifted' >&2; exit 1; }
grep -Fq "'ffmpegFontFile', '/opt/aid-fonts/current/aid-cjk-font'" "${ROOT_DIR}/sql/v1.0.0-beta.6.sql" \
  || { echo 'FAIL: beta.6 CJK font default path drifted' >&2; exit 1; }

mkdir -p "${TMP_ROOT}/compiler"
cat > "${TMP_ROOT}/compiler/gcc" <<'EOF'
#!/usr/bin/env bash
case "$*" in *-dumpversion*) echo '7.5.0' ;; *) echo 'gcc test 7.5.0' ;; esac
EOF
cat > "${TMP_ROOT}/compiler/g++" <<'EOF'
#!/usr/bin/env bash
echo 'g++ test 7.5.0'
EOF
cat > "${TMP_ROOT}/compiler/java" <<'EOF'
#!/usr/bin/env bash
echo 'openjdk version "11.0.0"' >&2
EOF
chmod +x "${TMP_ROOT}/compiler/gcc" "${TMP_ROOT}/compiler/g++" "${TMP_ROOT}/compiler/java"
unset JAVA_HOME
export PATH="${TMP_ROOT}/compiler:/usr/bin:/bin"
export CC="${TMP_ROOT}/compiler/gcc" CXX="${TMP_ROOT}/compiler/g++"
select_redis_build_compiler >/dev/null \
  || { echo 'FAIL: Redis GCC/G++ 7+ toolchain was not accepted' >&2; exit 1; }
[[ "${CC}" == "${TMP_ROOT}/compiler/gcc" && "${CXX}" == "${TMP_ROOT}/compiler/g++" ]] \
  || { echo 'FAIL: Redis compiler environment was not activated' >&2; exit 1; }

mkdir -p "${TMP_ROOT}/fixture/jdk/bin"
cat > "${TMP_ROOT}/fixture/jdk/release" <<'EOF'
JAVA_VERSION="17.0.8"
OS_ARCH="x86_64"
OS_NAME="Linux"
EOF
cat > "${TMP_ROOT}/fixture/jdk/bin/java" <<'EOF'
#!/usr/bin/env bash
echo 'java version "17.0.8" 2023-07-18 LTS' >&2
EOF
cat > "${TMP_ROOT}/fixture/jdk/bin/javac" <<'EOF'
#!/usr/bin/env bash
echo 'javac 17.0.8'
EOF
chmod +x "${TMP_ROOT}/fixture/jdk/bin/java" "${TMP_ROOT}/fixture/jdk/bin/javac"
tar -czf "${TMP_ROOT}/jdk-17.0.8.tar.gz" -C "${TMP_ROOT}/fixture" jdk

DOWNLOAD_COUNT=0
DOWNLOAD_URLS=()
require_download_tools() { :; }
bt_artifact_urls() { printf '%s\n' 'https://download.bt.cn/src/jdk/x64/jdk-17.0.8.tar.gz'; }
sha256_file() { printf '%s\n' '74b528a33bb2dfa02b4d74a0d66c9aff52e4f52924ce23a62d7f9eb1a6744657'; }
try_download() {
  DOWNLOAD_URLS+=("$1")
  cp "${TMP_ROOT}/jdk-17.0.8.tar.gz" "$2"
  DOWNLOAD_COUNT=$((DOWNLOAD_COUNT + 1))
}

prepare_exact_jdk >/dev/null
[[ -x "${JDK_HOME}/bin/java" ]] || { echo 'FAIL: Docker/source-build JDK was not installed' >&2; exit 1; }
[[ "${DOWNLOAD_URLS[0]}" == 'https://download.bt.cn/src/jdk/x64/jdk-17.0.8.tar.gz' ]] \
  || { echo 'FAIL: Docker/source-build JDK did not try the domestic mirror first' >&2; exit 1; }
prepare_exact_jdk >/dev/null
[[ "${DOWNLOAD_COUNT}" == "1" ]] || { echo 'FAIL: matching Docker/source-build JDK must skip repeated download' >&2; exit 1; }

prepare_manual_jdk >/dev/null
[[ -x "${JDK_HOME}/bin/java" ]] || { echo 'FAIL: managed JDK was not installed' >&2; exit 1; }
[[ "${JAVA_HOME}" == "${JDK_HOME}" ]] || { echo 'FAIL: JAVA_HOME was not refreshed in installer process' >&2; exit 1; }
[[ "${PATH}" == "${JDK_HOME}/bin:"* ]] || { echo 'FAIL: managed JDK was not prepended to PATH' >&2; exit 1; }
grep -Fq "export JAVA_HOME=\"${JDK_HOME}\"" "${JAVA_PROFILE_FILE}" \
  || { echo 'FAIL: persistent JAVA_HOME was not written' >&2; exit 1; }
grep -Fq 'export PATH="${JAVA_HOME}/bin:${PATH}"' "${JAVA_PROFILE_FILE}" \
  || { echo 'FAIL: persistent PATH was not written safely' >&2; exit 1; }

prepare_manual_jdk >/dev/null
[[ "${DOWNLOAD_COUNT}" == "1" ]] || { echo 'FAIL: matching manual JDK must reuse the verified shared archive' >&2; exit 1; }

echo 'manual runtime version tests passed'
