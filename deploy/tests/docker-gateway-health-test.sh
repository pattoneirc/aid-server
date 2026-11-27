#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AID_SH_LIBRARY_MODE=1
source "$ROOT_DIR/deploy/aid.sh"

docker() {
  local container="${@: -1}"
  case "$container" in
    aid-nginx) printf '%s\n' network-a network-b ;;
    aid-nginx-https) printf '%s\n' network-b ;;
    aid-web) printf '%s\n' network-b network-c ;;
    aid-server) printf '%s\n' "${BACKEND_NETWORK:-network-b}" ;;
  esac
}
env_get() {
  case "$1" in
    HTTPS_PUBLIC_DOMAIN) printf '%s' site.example.com ;;
    HTTPS_ADMIN_DOMAIN) printf '%s' admin.example.com ;;
    *) printf '%s' "$2" ;;
  esac
}
setting_get() {
  case "$1" in
    NGINX_BACKEND_ORIGIN) printf '%s' "${EXTERNAL_BACKEND_ORIGIN:-$2}" ;;
    *) printf '%s' "$2" ;;
  esac
}
curl() {
  local url="${@: -1}"
  case "$url" in
    http://127.0.0.1:80/|https://site.example.com:443/)
      [[ "${BREAK_WEB:-0}" == 0 ]] && printf '%s' '<!doctype html><html></html>' ;;
    http://127.0.0.1:8080/) printf '%s' 'backend-ready' ;;
    http://127.0.0.1:8089/prod-api/|https://admin.example.com:443/prod-api/)
      printf '%s' "${PROXY_BODY:-backend-ready}" ;;
    *) return 1 ;;
  esac
}

verify_docker_gateway aid-nginx http
verify_docker_gateway aid-nginx-https https
if BACKEND_NETWORK=network-a verify_docker_gateway aid-nginx http >/dev/null 2>&1; then
  echo 'Expected rejection when there is only pairwise network overlap' >&2
  exit 1
fi
if PROXY_BODY='<html>admin SPA fallback</html>' verify_docker_gateway aid-nginx http >/dev/null 2>&1; then
  echo 'Expected rejection when the proxy did not reach the backend' >&2
  exit 1
fi
if BREAK_WEB=1 verify_docker_gateway aid-nginx http >/dev/null 2>&1; then
  echo 'Expected rejection when Web is unavailable' >&2
  exit 1
fi

EXTERNAL_BACKEND_ORIGIN=https://upstream.example.com PROXY_BODY='external backend ready' verify_docker_gateway aid-nginx http
