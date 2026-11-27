#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_script="$ROOT_DIR/deploy/build-release-from-source.sh"
source <(awk '
  /^(require_uint_range|max_value|clamp_profile_memory|validate_profile|configure_resource_profiles|load_stage_profile|apply_realtime_stage_budget|report_web_stage_failure)\(\) \{/ { capture=1 }
  capture { print }
  /^}$/ { capture=0 }
' "$build_script")
die() { printf '%s\n' "$*" >&2; exit 1; }
warn() { printf '%s\n' "$*" >&2; }
log() { :; }
read_memory_metrics() { :; }
getconf() { echo 4; }
RESOURCE_RESERVE_PERCENT=15
MIN_AVAILABLE_MEMORY_MB=512
PAUSED_CPU_MILLI=100
SYSTEM_MEMORY_TOTAL_MB=3718
SYSTEM_MEMORY_AVAILABLE_MB=3100
SYSTEM_SWAP_FREE_MB=4096
CPU_IDLE_TENTHS=950
configure_resource_profiles
load_stage_profile node
[[ "$STAGE_MEMORY_MAX_MB" == 1487 ]]
load_stage_profile web
apply_realtime_stage_budget web Web
[[ "$STAGE_MEMORY_MAX_MB" == 2416 && "$STAGE_NODE_HEAP_MB" == 3072 ]]
AID_BUILD_WEB_MEMORY_MAX_MB=2000 AID_BUILD_WEB_HEAP_MB=2048 configure_resource_profiles
load_stage_profile web
SYSTEM_MEMORY_AVAILABLE_MB=1700
apply_realtime_stage_budget web Web
[[ "$STAGE_MEMORY_MAX_MB" == 1143 && "$STAGE_NODE_HEAP_MB" == 2048 ]]
if (SYSTEM_SWAP_FREE_MB=0; load_stage_profile web; apply_realtime_stage_budget web Web) >/dev/null 2>&1; then
  echo 'Expected rejection for insufficient RAM and swap' >&2
  exit 1
fi

memory_dir="$(mktemp -d)"
trap 'rm -rf -- "$memory_dir"' EXIT
HOST_MEMORY_CGROUP="$memory_dir"
ACTIVE_HOST_UNIT=''
printf 'oom 1\noom_kill 1\n' > "$memory_dir/memory.events"
[[ "$(report_web_stage_failure host 1 2>&1)" == *'exit=1, cgroup OOM=confirmed'* ]]
printf 'oom 0\noom_kill 0\n' > "$memory_dir/memory.events"
[[ "$(report_web_stage_failure host 137 2>&1)" == *'exit=137, cgroup OOM=not-observed'* ]]

# A removed systemd scope can still be identified by its exact kernel cgroup.
WEB_STAGE_STARTED_AT=100
HOST_MEMORY_CGROUP=/sys/fs/cgroup/system.slice/aid-web-build.scope
find_cgroup2_mount() { echo /sys/fs/cgroup; }
journalctl() { echo 'oom_memcg=/system.slice/aid-web-build.scope-other,task=other'; }
[[ "$(report_web_stage_failure host 1 2>&1)" == *'exit=1, cgroup OOM=unknown'* ]]
journalctl() { echo 'oom_memcg=/system.slice/aid-web-build.scope,task=node'; }
[[ "$(report_web_stage_failure host 1 2>&1)" == *'exit=1, cgroup OOM=confirmed'* ]]
