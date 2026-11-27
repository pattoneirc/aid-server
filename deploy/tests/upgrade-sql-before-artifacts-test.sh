#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "${TMP_ROOT}"' EXIT

export AID_SH_LIBRARY_MODE=1
export AID_DATA_ROOT="${TMP_ROOT}/data"
# shellcheck source=../aid.sh
source "${ROOT_DIR}/deploy/aid.sh"

migration_order="$({
  sql_migration_sort_key '/tmp/v1.0.0.sql'
  sql_migration_sort_key '/tmp/v1.0.0-beta.10.sql'
  sql_migration_sort_key '/tmp/v1.0.0-rc.2.sql'
  sql_migration_sort_key '/tmp/v1.0.0-beta.2.sql'
  sql_migration_sort_key '/tmp/v2.0.0.sql'
} | sort -t '|' -k1,1 | awk -F '|' '{sub(".*/", "", $2); print $2}')"
expected_order="$(printf '%s\n' \
  v1.0.0-beta.2.sql \
  v1.0.0-beta.10.sql \
  v1.0.0-rc.2.sql \
  v1.0.0.sql \
  v2.0.0.sql)"
[[ "${migration_order}" == "${expected_order}" ]] \
  || { echo "FAIL: migration order is not SemVer order: ${migration_order}" >&2; exit 1; }

apply_source="${ROOT_DIR}/deploy/updater/internal/task/apply.go"
backup_line="$(grep -nF 'r.beginVersionChange(t, tag)' "${apply_source}" | cut -d: -f1)"
sql_line="$(grep -nF 'dbexec.ExecuteDir(r.cfg.Database, sqlDir)' "${apply_source}" | cut -d: -f1)"
replace_line="$(grep -nF 'r.replaceArtifacts(packageRoot, newJar)' "${apply_source}" | cut -d: -f1)"
(( backup_line < sql_line && sql_line < replace_line ))
grep -Fq -- '-apply-local-package' "${ROOT_DIR}/deploy/aid.sh"
grep -Fq 'mark_sql_baseline_from_dir "${REPO_DIR}/sql"' "${ROOT_DIR}/deploy/aid.sh" \
  || { echo 'FAIL: fresh installs must record the migration baseline' >&2; exit 1; }

echo 'upgrade SQL-before-artifacts tests passed'
