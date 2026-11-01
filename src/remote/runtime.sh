#!/usr/bin/env bash
# Host functions are sent with each operation; no runtime scripts are installed in the stack.

compoza_fail() { printf '%s\n' "$1" >&2; return 1; }

# Refuse symlinked ancestors before reading metadata or mutating the stack.
compoza_root() {
  local part='' component
  local parts=()
  [[ "$root" = /* ]] && [ "$root" != / ] || return 1
  IFS=/ read -r -a parts <<< "$root"
  for component in "${parts[@]}"; do
    [ -z "$component" ] && continue
    [ "$component" != . ] && [ "$component" != .. ] || return 1
    part="$part/$component"
    [ ! -L "$part" ] || return 1
  done
}

compoza_lock() {
  umask 077
  compoza_root || { compoza_fail 'Stack path contains a symlink or unsafe component'; return 1; }
  mkdir -p "$root"
  [ ! -L "$root/.deploy-lock" ] || { compoza_fail 'Unsafe lock path'; return 1; }
  mkdir "$root/.deploy-lock" 2>/dev/null || { compoza_fail 'Stack is locked; inspect .deploy-lock/owner before removing a stale lock'; return 1; }
  printf '%s\n' "pid=$$ host=$(hostname)" > "$root/.deploy-lock/owner"
  trap 'rm -rf -- "$root/.deploy-lock"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
}

compoza_decode() {
  if base64 --decode </dev/null >/dev/null 2>&1; then base64 --decode; else base64 -D; fi
}

compoza_metadata() {
  [ -f "$metadata" ] && [ ! -L "$metadata" ] || { compoza_fail 'No safe deployed configuration; deploy this destination first'; return 1; }
  jq -se 'length == 1 and (.[0] |
    .version == 1 and
    (.project | type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9_-]*$")) and
    (.profiles | type == "array" and all(.[]; type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9_-]*$"))) and
    (.files | type == "array" and all(.[]; type == "string" and test("^[a-zA-Z0-9_/-][a-zA-Z0-9_./-]*$") and (split("/") | all(. != "" and (startswith(".") | not))))) and
    (.overlay | . == null or (type == "string" and startswith("/") and (explode | all(. >= 32)))) and
    (.hostEnv | . == null or (type == "string" and startswith("/") and (explode | all(. >= 32)))) and
    (.managed | type == "boolean") and (.unroute | type == "string"))' "$metadata" >/dev/null 2>&1 || { compoza_fail 'Invalid deployed lifecycle metadata; redeploy with the current CLI'; return 1; }
}

# An existing stack file is overwritten only when the previous metadata identifies it as tool-owned.
compoza_target() {
  local relative=$1 part="$root" component
  local parts=()
  IFS=/ read -r -a parts <<< "$relative"
  for component in "${parts[@]}"; do
    part="$part/$component"
    [ ! -L "$part" ] || { compoza_fail 'Stack output contains a symlink'; return 1; }
  done
  [ ! -e "$part" ] && return 0
  [ -f "$part" ] || { compoza_fail 'Stack output is not a regular file'; return 1; }
  if [ "$relative" = .env ] && [ ! -f "$root/.compoza.json" ]; then
    compoza_fail 'Existing .env is operator-owned; move it to a separate host file and select remote.envFile before deploying'; return 1
  fi
  [ -f "$root/.compoza.json" ] && jq -e --arg file "$relative" '$file == ".env" or $file == ".compoza.json" or (.files | index($file) != null)' "$root/.compoza.json" >/dev/null 2>&1 || { compoza_fail 'Refusing to overwrite an operator-owned stack file; move it or choose another stackDir'; return 1; }
}

# Resolve paths without requiring GNU realpath, including missing optional host files.
compoza_canonical() {
  local pending=$1 resolved='' component link count=0
  case "$pending" in /*) ;; *) pending="$root/$pending";; esac
  pending=${pending#/}
  while [ -n "$pending" ]; do
    component=${pending%%/*}
    if [ "$pending" = "$component" ]; then pending=''; else pending=${pending#*/}; fi
    case "$component" in ''|.) continue;; ..) resolved=${resolved%/*}; continue;; esac
    if [ -L "$resolved/$component" ]; then
      count=$((count + 1)); [ "$count" -le 40 ] || return 1
      link=$(readlink "$resolved/$component" && printf '.') || return 1
      link=${link%.}; link=${link%$'\n'}
      case "$link" in *$'\n'*|*$'\r'*) return 1;; esac
      case "$link" in /*) resolved=''; link=${link#/};; esac
      pending="$link${pending:+/$pending}"
    else resolved="$resolved/$component"; fi
  done
  printf '%s' "${resolved:-/}"
}

compoza_owned() {
  case "$1" in "$root"/*) jq -e --arg file "${1#"$root"/}" '.files | index($file) != null' "$metadata" >/dev/null 2>&1;; *) return 1;; esac
}

compoza_model_file() {
  local path=$1 secret=$2 required=$3 actual
  actual=$(compoza_canonical "$path") || return 1
  case "$path" in /*) ;; *) compoza_owned "$actual" || return 1;; esac
  if [ "$secret" = yes ]; then
    case "$path" in /*) ;; *) return 1;; esac
    compoza_owned "$actual" && return 1
  fi
  if [ "$actual" = "$root/.env" ]; then actual=$env_file
  elif compoza_owned "$actual" && [ -n "${upload-}" ]; then actual="$upload/${actual#"$root"/}"; fi
  if [ "$required" = no ] && [ ! -e "$actual" ]; then return 0; fi
  [ -f "$actual" ] && [ -r "$actual" ]
}

# Only declared read-only assets may be bound relatively; absolute data folders remain operator-owned.
compoza_validate_model() {
  local record path kind required readonly actual
  while IFS= read -r record; do
    [ "$record" != '!invalid' ] || return 1
    path=$(printf '%s' "$record" | jq -er '.[0]') || return 1
    kind=$(printf '%s' "$record" | jq -er '.[1]') || return 1
    required=$(printf '%s' "$record" | jq -er '.[2]') || return 1
    readonly=$(printf '%s' "$record" | jq -er '.[3]') || return 1
    if [ "$kind" = bind ]; then
      actual=$(compoza_canonical "$path") || return 1
      case "$actual" in "$root/.env"|"$root/.compoza.json"|"$root/.deploy-lock"|"$root/.deploy-lock/"*) return 1;; esac
      case "$path" in /*) if ! compoza_owned "$actual"; then continue; fi;; esac
      [ "$readonly" = yes ] && compoza_owned "$actual" || return 1
      compoza_model_file "$path" no yes || return 1
    else compoza_model_file "$path" "$kind" "$required" || return 1; fi
  done < <(jq -sc "$model_filter" 2>/dev/null || printf '%s\n' '!invalid')
}

# Compose receives a clean environment and literal arguments; secrets are passed only through file paths.
compoza_compose() {
  local profile overlay host_env permissions
  if jq -e .managed "$metadata" >/dev/null 2>&1; then
    [ -f "$env_file" ] && [ ! -L "$env_file" ] || { compoza_fail 'Missing or unsafe managed dotenv'; return 1; }
    case "$(uname -s)" in Darwin) permissions=$(stat -f '%Lp' "$env_file");; *) permissions=$(stat -c '%a' "$env_file");; esac
    [[ "$permissions" =~ ^[0-7]+$ ]] && [ "$((8#$permissions & 077))" -eq 0 ] || { compoza_fail 'Managed dotenv must have owner-only permissions'; return 1; }
  fi
  local args=(--project-name "$(jq -er '.project' "$metadata")" --project-directory "$root")
  if [ "$#" -gt 0 ] && [ "$1" = normalize ]; then
    shift
    while [ "$#" -gt 0 ]; do args+=(--file "$1"); shift; done
    set -- config --no-interpolate --no-env-resolution --no-path-resolution
  else
    args+=(--file "$compose_file")
    overlay=$(jq -r '.overlay // empty' "$metadata")
    [ -z "$overlay" ] || args+=(--file "$overlay")
  fi
  while IFS= read -r profile; do args+=(--profile "$profile"); done < <(jq -r '.profiles[]' "$metadata")
  host_env=$(jq -r '.hostEnv // empty' "$metadata")
  if [ -n "$host_env" ]; then
    [ -f "$host_env" ] && [ -r "$host_env" ] || { compoza_fail 'Configured host env file is missing'; return 1; }
    args+=(--env-file "$host_env")
  fi
  args+=(--env-file "$env_file")
  env -i HOME="$HOME" USER="${USER-}" PATH="$PATH" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR-}" DOCKER_HOST="${DOCKER_HOST-}" DOCKER_CONTEXT="${DOCKER_CONTEXT-}" DOCKER_CONFIG="${DOCKER_CONFIG-$HOME/.docker}" docker compose "${args[@]}" "$@"
}

compoza_compose_safe() {
  if ! jq -e '.managed' "$metadata" >/dev/null 2>&1; then compoza_compose "$@"; return; fi
  case "${1-}" in
    ps) compoza_compose "$@" --format json 2>/dev/null | jq -c --rawfile snapshot "$env_file" "$status_filter" 2>/dev/null || { compoza_fail 'Cannot safely read deployed status; diagnostics suppressed'; return 1; };;
    logs) compoza_compose "$@" 2>/dev/null;;
    *) if ! compoza_compose "$@" >/dev/null 2>&1; then compoza_fail 'Compose action failed; secret-bearing diagnostics suppressed'; return 1; fi;;
  esac
}
