#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${TEST_DIR}/.." && pwd)"

export AID_SH_LIBRARY_MODE=1
export AID_DATA_ROOT=/tmp/aid-mirror-selection-test
# shellcheck source=../aid.sh
source "${DEPLOY_DIR}/aid.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 模拟 Registry 根接口：根地址有响应但路径不通的仓库留待清单检查。
curl() {
  local url="${*: -1}"
  case "${url}" in
    https://fast.example/v2/) printf '401 0.040' ;;
    https://slow.example/v2/) printf '200 0.320' ;;
    https://prefixed.example/v2/) printf '404 0.020' ;;
    *) return 28 ;;
  esac
}

AID_DOCKER_MIRRORS='HTTPS://slow.example/,fast.example,slow.example,dead.example,prefixed.example/proxy'
DOCKER_MIRRORS="${AID_DOCKER_MIRRORS}"
if [[ "${1:-}" == builder ]]; then
  # 只加载镜像函数，避免启动真实的源码构建。
  source <(awk '/^(normalize_docker_mirror|probe_docker_mirror|resolve_docker_mirror_order|docker_mirror_order_for_image|probe_docker_image_manifest|pull_docker_mirror|try_docker_mirrors|ensure_docker_image)\(\) / { printing=1 } printing { print } /^}$/ { printing=0 }' \
    "${DEPLOY_DIR}/build-release-from-source.sh")
fi

DOCKER_MIRRORS_RESOLVED=0
DOCKER_MIRROR_ORDER=''
resolve_docker_mirror_order
[[ "${DOCKER_MIRROR_ORDER}" == 'fast.example slow.example prefixed.example/proxy' ]] \
  || fail "测速、去重或超时来源淘汰错误: ${DOCKER_MIRROR_ORDER}"

[[ "$(dockerhub_mirror_image fast.example mysql:5.7)" == 'fast.example/library/mysql:5.7' ]] \
  || fail '官方 library 镜像映射错误'
[[ "$(dockerhub_mirror_image fast.example apache/rocketmq:5.3.1)" == 'fast.example/apache/rocketmq:5.3.1' ]] \
  || fail '组织镜像映射错误'
[[ -z "$(normalize_docker_mirror 'https://bad.example/path?token=secret' 2>/dev/null || true)" ]] \
  || fail '带查询参数的镜像地址未被拒绝'

timeout() { timeout_args="$*"; }
docker() { [[ "$*" == 'buildx version' ]]; }
probe_docker_image_manifest 'fast.example/library/mysql@sha256:test'
[[ "${timeout_args}" == "-k 2s ${IMAGE_MANIFEST_PROBE_TIMEOUT_SECONDS} docker buildx imagetools inspect --raw fast.example/library/mysql@sha256:test" ]] \
  || fail '应使用 Buildx 优先检查原始清单'
docker() { return 1; }
probe_docker_image_manifest 'fast.example/library/mysql@sha256:test'
[[ "${timeout_args}" == "-k 2s ${IMAGE_MANIFEST_PROBE_TIMEOUT_SECONDS} docker manifest inspect fast.example/library/mysql@sha256:test" ]] \
  || fail '未安装 Buildx 时应保留 Docker 清单检查'
unset -f timeout docker

# 固定镜像用同一摘要探测和拉取。只要摘要预检失败，就不下载该来源的镜像层。
PULL_ATTEMPTS=''
probe_docker_image_manifest() {
  [[ "$1" == 'fast.example/library/mysql@sha256:test' || "$1" == 'slow.example/library/mysql@sha256:test' ]]
}
pull_docker_image() {
  PULL_ATTEMPTS+="$1 "
  [[ "$2" == "${MIRROR_IMAGE_PULL_TIMEOUT_SECONDS}" ]] || fail '国内拉取未使用单独的超时'
  [[ "$1" == 'slow.example/library/mysql@sha256:test' ]]
}
local_image_matches_digest() { return 0; }
docker() {
  [[ "$1" == tag ]]
}

DOCKER_MIRROR_ORDER='fast.example dead.example slow.example'
DOCKER_MIRRORS_RESOLVED=1
try_docker_mirrors 'mysql:5.7' 'MySQL5.7' 'sha256:test' \
  || fail '实际拉取未回退到可用镜像'
[[ "${PULL_ATTEMPTS}" == 'fast.example/library/mysql@sha256:test slow.example/library/mysql@sha256:test ' ]] \
  || fail "manifest 预检与实际拉取回退顺序错误: ${PULL_ATTEMPTS}"

# 同一个镜像源在 MySQL 拉取失败后仍可用于 Go。首个可用源无需等待无关慢探测。
probe_finished="$(mktemp)"
rm -f -- "${probe_finished}"
go_trace="$(
  probe_docker_image_manifest() {
    [[ "$1" == 'fast.example/library/golang@sha256:test' ]] && return 0
    sleep 5
    : > "${probe_finished}"
    return 1
  }
  pull_docker_image() {
    [[ ! -e "${probe_finished}" ]] || fail '快速源拉取前等待了无关清单探测'
    printf 'pull %s\n' "$1"
    [[ "$1" == 'fast.example/library/golang@sha256:test' ]]
  }
  try_docker_mirrors 'golang:1.22.12-bookworm' 'Go' 'sha256:test'
)" || fail '没有按镜像独立选源'
grep -Fxq 'pull fast.example/library/golang@sha256:test' <<<"${go_trace}" || fail "快速源未按固定摘要拉取"
rm -f -- "${probe_finished}"

# 未固定的用户自定义标签保留原有预检失败后回退行为。
PULL_ATTEMPTS=''
probe_docker_image_manifest() { [[ "$1" == 'fast.example/library/custom:latest' ]]; }
pull_docker_image() {
  PULL_ATTEMPTS+="$1 "
  [[ "$1" == 'slow.example/library/custom:latest' ]]
}
DOCKER_MIRROR_ORDER='slow.example fast.example'
try_docker_mirrors 'custom:latest' 'custom' '' || fail '自定义标签回退失败'
[[ "${PULL_ATTEMPTS}" == 'fast.example/library/custom:latest slow.example/library/custom:latest ' ]] \
  || fail "自定义标签回退顺序错误: ${PULL_ATTEMPTS}"

PULL_ATTEMPTS=''
RESOLVED_DEPENDENCY_REGION=cn
DEPENDENCY_INSTALL_MODE=auto
DOCKER_MIRROR_ORDER='dead.example'
docker_image_digest() { printf '%s\n' 'sha256:test'; }
probe_docker_image_manifest() { return 1; }
pull_docker_image() {
  PULL_ATTEMPTS+="$1 "
  [[ "$1" == 'mysql@sha256:test' ]]
}
ensure_docker_image 'mysql:5.7' 'MySQL5.7' || fail '国内固定摘要预检全部失败时未回退官方源'
[[ "${PULL_ATTEMPTS}" == 'mysql@sha256:test ' ]] || fail '官方回退未使用固定摘要'

PULL_ATTEMPTS=''
RESOLVED_DEPENDENCY_REGION=global
DOCKER_MIRRORS_RESOLVED=0
probe_docker_mirror() { fail '国外走官方源时不应探测国内仓库'; }
ensure_docker_image 'mysql:5.7' 'MySQL5.7' || fail '国外线路未使用官方源'
[[ "${PULL_ATTEMPTS}" == 'mysql@sha256:test ' && "${DOCKER_MIRRORS_RESOLVED}" == 0 ]] \
  || fail '国外线路未优先使用官方固定摘要'

# 即使仓库探测顺序不同，内置来源也要优先使用实测完整下载最快的地址。
AID_DOCKER_MIRRORS="${DEFAULT_DOCKER_MIRRORS}"
DOCKER_MIRRORS="${DEFAULT_DOCKER_MIRRORS}"
[[ "${DEFAULT_DOCKER_MIRRORS}" == 'docker.m.daocloud.io,docker.1panel.live,docker.1ms.run' ]] \
  || fail '默认镜像候选应为通过公网验证的仓库'
DOCKER_MIRROR_ORDER='docker.1ms.run docker.m.daocloud.io docker.1panel.live'
expected_order() {
  local actual
  actual="$(docker_mirror_order_for_image "$1" | paste -sd ' ' -)"
  [[ "${actual}" == "$2" ]] || fail "$1 的来源顺序不符: ${actual}"
}
for tested_image in alpine/git:2.47.2 maven:3.9.9-eclipse-temurin-17 node:22.22.0-bookworm-slim golang:1.22.12-bookworm; do
  expected_order "${tested_image}" 'docker.1panel.live docker.1ms.run docker.m.daocloud.io'
done
expected_order 'mysql:5.7' 'docker.m.daocloud.io docker.1ms.run docker.1panel.live'
for tested_image in nginx:1.25-alpine debian:bookworm-slim docker:27-cli; do
  expected_order "${tested_image}" 'docker.m.daocloud.io docker.1panel.live docker.1ms.run'
done
expected_order 'redis:7-alpine' 'docker.1ms.run docker.1panel.live docker.m.daocloud.io'

DOCKER_MIRROR_ORDER='docker.1ms.run docker.m.daocloud.io'
expected_order 'golang:1.22.12-bookworm' 'docker.1ms.run docker.m.daocloud.io'

AID_DOCKER_MIRRORS='docker.m.daocloud.io,docker.1panel.live'
DOCKER_MIRRORS="${AID_DOCKER_MIRRORS}"
DOCKER_MIRROR_ORDER='docker.m.daocloud.io docker.1panel.live'
expected_order 'alpine/git:2.47.2' 'docker.m.daocloud.io docker.1panel.live'

unset AID_DOCKER_MIRROR_PULL_TIMEOUT_SECONDS AID_IMAGE_PULL_TIMEOUT_SECONDS
MIRROR_IMAGE_PULL_TIMEOUT_SECONDS=120
pull_docker_image() { actual_timeout="$2"; }
for tested_image in maven:3.9.9-eclipse-temurin-17 node:22.22.0-bookworm-slim golang:1.22.12-bookworm; do
  pull_docker_mirror "docker.1panel.live/library/${tested_image%%:*}@sha256:test" "${tested_image}" "${tested_image}" 'sha256:test'
  [[ "${actual_timeout}" == 180 ]] || fail "${tested_image} 在 1Panel 的预算小于测试要求"
done
pull_docker_mirror 'docker.m.daocloud.io/library/maven@sha256:test' 'maven:3.9.9-eclipse-temurin-17' 'Maven' 'sha256:test'
[[ "${actual_timeout}" == 120 ]] || fail 'Maven 的其他国内源应使用通用预算'
AID_DOCKER_MIRROR_PULL_TIMEOUT_SECONDS=150
MIRROR_IMAGE_PULL_TIMEOUT_SECONDS=150
pull_docker_mirror 'docker.1panel.live/library/maven@sha256:test' 'maven:3.9.9-eclipse-temurin-17' 'Maven' 'sha256:test'
[[ "${actual_timeout}" == 150 ]] || fail 'Maven 未尊重用户设置的预算'

echo 'PASS: Docker 多镜像测速与实际拉取回退'
