#!/usr/bin/env bash
set -u

GROUP_FOLDER="${1:-jambutter-project}"
GROUP_LOG_DIR="groups/${GROUP_FOLDER}/logs"
SERVICE_NAME="nanoclaw.service"
IMAGE_NAME="nanoclaw-agent:latest"

line() {
  printf '%s\n' "------------------------------------------------------------"
}

section() {
  printf '\n%s\n' "$1"
}

safe_cmd() {
  "$@" 2>/dev/null
}

echo "NanoClaw Health Snapshot ($(date -Iseconds))"
echo "Group: ${GROUP_FOLDER}"
line

section "[1/5] Service status"
if safe_cmd systemctl --user is-active --quiet "${SERVICE_NAME}"; then
  echo "service: active"
else
  status="$(safe_cmd systemctl --user is-active "${SERVICE_NAME}" || echo "unknown")"
  echo "service: ${status}"
fi

main_pid="$(safe_cmd systemctl --user show -p MainPID --value "${SERVICE_NAME}" || true)"
echo "main_pid: ${main_pid:-n/a}"

section "[2/5] Active agent containers"
if safe_cmd docker ps >/dev/null; then
  mapfile -t running < <(docker ps --filter "ancestor=${IMAGE_NAME}" --format '{{.ID}} {{.Status}} {{.Names}}')
  if [ "${#running[@]}" -eq 0 ]; then
    echo "active_containers: 0"
  else
    echo "active_containers: ${#running[@]}"
    printf '%s\n' "${running[@]}"
  fi
else
  echo "active_containers: unavailable (docker permission/bus issue)"
fi

section "[3/5] Last group run"
if [ -d "${GROUP_LOG_DIR}" ]; then
  latest_log="$(ls -1t "${GROUP_LOG_DIR}"/container-*.log 2>/dev/null | head -n 1)"
  if [ -n "${latest_log}" ]; then
    echo "log_file: ${latest_log}"
    duration="$(grep -m1 '^Duration:' "${latest_log}" | sed 's/^Duration:[[:space:]]*//')"
    exit_code="$(grep -m1 '^Exit Code:' "${latest_log}" | sed 's/^Exit Code:[[:space:]]*//')"
    ts="$(grep -m1 '^Timestamp:' "${latest_log}" | sed 's/^Timestamp:[[:space:]]*//')"
    echo "timestamp: ${ts:-n/a}"
    echo "duration_ms: ${duration:-n/a}"
    echo "exit_code: ${exit_code:-n/a}"
  else
    echo "last_run: no container logs found in ${GROUP_LOG_DIR}"
  fi
else
  echo "last_run: log directory not found (${GROUP_LOG_DIR})"
fi

section "[4/5] Last runtime error"
last_error="$(safe_cmd journalctl --user -u "${SERVICE_NAME}" -n 500 --no-pager | grep ' ERROR ' | tail -n 1)"
if [ -n "${last_error}" ]; then
  echo "${last_error}"
else
  echo "none found in last 500 log lines"
fi

section "[5/5] Last container completion"
last_done="$(safe_cmd journalctl --user -u "${SERVICE_NAME}" -n 500 --no-pager | grep 'Container completed' | tail -n 1)"
if [ -n "${last_done}" ]; then
  echo "${last_done}"
else
  echo "no completion line found in last 500 log lines"
fi

line
