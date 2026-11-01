#!/usr/bin/env bash
# Shared host runtime. Compatible with Bash 3.2; JSON is data handled only by jq.

# Fails with a value-free diagnostic, never shell data or third-party stderr.
compoza_fail() { printf '%s\n' "$1" >&2; return 1; }

compoza_id() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] && [ "$1" != . ] && [ "$1" != .. ]; }

# Refuses symlinked ancestors even for read-only state inspection.
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
  [ ! -L "$root/releases" ] && [ ! -L "$root/.activations" ]
}

compoza_release() {
  [ "$1" != '-' ] || return 0
  compoza_id "$1" || return 1
  local directory="$root/releases/$1" name
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  for name in compose.sh manifest.json successful; do
    [ -f "$directory/$name" ] && [ ! -L "$directory/$name" ] || return 1
  done
}

compoza_release_link() {
  [ -L "$1" ] || return 1
  local value
  value=$(readlink "$1") || return 1
  case "$value" in ../../releases/*) value=${value#../../releases/};; *) return 1;; esac
  compoza_id "$value" || return 1
  printf '%s' "$value"
}

# Reads one current link exactly once: release, predecessor and secret source stay coherent.
# v1 activation metadata remains readable; no legacy shell program is parsed or executed.
compoza_read_state_checked() {
  compoza_root || return 1
  release_id=- previous_id=- secret_file=legacy secret_required=no secret_managed=no
  local target record source fields permissions
  [ -e "$root/current" ] || [ -L "$root/current" ] || return 0
  [ -L "$root/current" ] || return 1
  target=$(readlink "$root/current") || return 1
  case "$target" in
    releases/*)
      release_id=${target#releases/}; compoza_id "$release_id" || return 1
      if [ -e "$root/previous" ] || [ -L "$root/previous" ]; then
        [ -L "$root/previous" ] || return 1
        previous_id=$(readlink "$root/previous") || return 1
        case "$previous_id" in releases/*) previous_id=${previous_id#releases/};; *) return 1;; esac
        compoza_id "$previous_id" || return 1
      fi;;
    .activations/*)
      [[ "$target" =~ ^\.activations/[a-f0-9]{32}$ ]] || return 1
      record="$root/$target"
      [ -d "$record" ] && [ ! -L "$record" ] || return 1
      release_id=$(compoza_release_link "$record/release") || return 1
      if [ -e "$record/previous" ] || [ -L "$record/previous" ]; then
        previous_id=$(compoza_release_link "$record/previous") || return 1
      fi
      [ -L "$record/manifest.json" ] && [ "$(readlink "$record/manifest.json")" = release/manifest.json ] || return 1
      if [ -L "$record/compose.sh" ]; then
        [ "$(readlink "$record/compose.sh")" = release/compose.sh ] || return 1
      else
        [ -f "$record/compose.sh" ] || return 1
      fi
      source="$record/secret-source.json"
      if [ -e "$source" ] || [ -L "$source" ]; then
        [ -f "$source" ] && [ ! -L "$source" ] || return 1
        fields=$(jq -ser 'if length == 1 then .[0] else error("invalid source") end | if (type == "object" and has("path") and ((.path == null) or (.path | type == "string" and startswith("/") and ((test("[[:space:]]") | not) and (explode | all(. > 0))))) and (.required | type == "boolean") and (.managed | type == "boolean") and (if .path == null then (.required == false and .managed == false) elif .managed then .required == true else true end)) then [(.path // "-"), (if .required then "yes" else "no" end), (if .managed then "yes" else "no" end)] | join("\n") else error("invalid source") end' "$source" 2>/dev/null) || return 1
        { IFS= read -r secret_file; IFS= read -r secret_required; IFS= read -r secret_managed; } <<< "$fields"
        if [ "$secret_managed" = yes ] && [ "$secret_file" != '-' ]; then
          [ ! -L "$root/.secrets" ] && [ -d "$root/.secrets" ] || return 1
          [ "${secret_file%/*}" = "$root/.secrets" ] && [ ! -L "$secret_file" ] && [ -f "$secret_file" ] || return 1
          case "$(uname -s)" in Darwin) permissions=$(stat -f '%Lp' "$secret_file");; *) permissions=$(stat -c '%a' "$secret_file");; esac
          [[ "$permissions" =~ ^[0-7]+$ ]] && [ "$((8#$permissions & 077))" -eq 0 ] || return 1
        fi
      fi;;
    *) return 1;;
  esac
  compoza_release "$release_id" && compoza_release "$previous_id"
}

compoza_read_state() {
  compoza_read_state_checked || { compoza_fail 'Unsafe or missing deployed release state'; return 1; }
}

# A v2 release uses structured launch metadata and the ordinary shell runtime.
# Old release programs are retained for diagnosis, but never invoked by this runtime.
compoza_supported() {
  local name
  for name in compose.sh compose.json runtime.sh model.jq status.jq; do
    [ -f "$candidate/$name" ] && [ ! -L "$candidate/$name" ] || { compoza_fail 'Archived release runtime is unsupported; redeploy this version with the current CLI before lifecycle or rollback'; return 1; }
  done
  compoza_metadata "$candidate" || return 1
  grep -q '^# compoza-runtime-v2$' "$candidate/compose.sh" || { compoza_fail 'Archived release runtime is unsupported; redeploy this version with the current CLI before lifecycle or rollback'; return 1; }
  [ "$secret_file" != legacy ] || { compoza_fail 'Archived secret source is unknown; redeploy with an explicit secret source before lifecycle or rollback'; return 1; }
}

compoza_lock() {
  umask 077
  compoza_root || { compoza_fail 'Stack path contains a symlink or unsafe component; refusing mutation'; return 1; }
  mkdir -p "$root"
  [ ! -L "$root/.deploy-lock" ] || { compoza_fail 'Unsafe lock path'; return 1; }
  mkdir "$root/.deploy-lock" 2>/dev/null || { compoza_fail 'Stack is locked; inspect .deploy-lock/owner before removing a stale lock'; return 1; }
  printf '%s\n' "pid=$$ host=$(hostname)" > "$root/.deploy-lock/owner"
  trap 'rm -f "$root/.deploy-lock/owner"; rmdir "$root/.deploy-lock"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  mkdir -p "$root/releases" "$root/.activations"
  local pointer
  for pointer in current previous; do
    [ ! -e "$root/$pointer" ] || [ -L "$root/$pointer" ] || { compoza_fail 'Unsafe release pointer'; return 1; }
  done
}

compoza_decode() {
  if base64 --decode </dev/null >/dev/null 2>&1; then base64 --decode; else base64 -D; fi
}

# Reads secret bytes only from transaction stdin; exclusive creation and umask protect snapshots.
compoza_stage_secret() {
  local identity=$1 encoded
  [ ! -L "$root/.secrets" ] || return 1
  mkdir -p "$root/.secrets" && chmod 700 "$root/.secrets" || return 1
  [ ! -e "$root/.secrets/$identity.env" ] && [ ! -L "$root/.secrets/$identity.env" ] || return 1
  IFS= read -r encoded || return 1
  (umask 077; set -o noclobber; printf '%s' "$encoded" | compoza_decode > "$root/.secrets/$identity.env") 2>/dev/null
}

# Resolves existing symlinks and dot components without GNU realpath/readlink extensions.
# Missing optional files still receive full lexical and existing-parent validation.
compoza_canonical() {
  local pending=$1 resolved='' component link count=0
  case "$pending" in /*) ;; *) pending="$candidate/$pending";; esac
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

compoza_model_file() {
  local path=$1 secret=$2 required=$3 actual
  actual=$(compoza_canonical "$path") || return 1
  if [ "$secret" = yes ]; then
    case "$path" in /*) ;; *) return 1;; esac
    case "$actual" in "$candidate"|"$candidate"/*) return 1;; esac
  fi
  if [ "$required" = no ] && [ ! -e "$actual" ]; then return 0; fi
  [ -f "$actual" ] && [ -r "$actual" ] || return 1
  case "$actual" in
    "$candidate"/*) jq -e --arg path "${actual#"$candidate"/}" '.files | index($path) != null' "$candidate/manifest.json" >/dev/null 2>&1 || return 1;;
  esac
}

# jq emits only a validated path-check protocol; no model bytes or diagnostics leave the host.
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
      case "$path:$actual" in /*:*) case "$actual" in "$candidate"|"$candidate"/*) ;; *) continue;; esac;; esac
      [ "$readonly" = yes ] || return 1
      case "$actual" in "$candidate"/*) ;; *) return 1;; esac
      compoza_model_file "$path" no yes || return 1
    else
      compoza_model_file "$path" "$kind" "$required" || return 1
    fi
  done < <(jq -sc -f "$candidate/model.jq" 2>/dev/null || printf '%s\n' '!invalid')
}

# Validates the entire launch document before process substitutions can extract partial data.
compoza_metadata() {
  local release=$1
  jq -se 'length == 1 and (.[0] | .version == 2 and (.arguments | type == "array" and all(.[]; type == "string" and (explode | all(. > 0)))) and (.images | type == "array" and all(.[]; (.name | type == "string" and test("^[A-Z_][A-Z0-9_]*_IMAGE$")) and (.value | type == "string" and (explode | all(. > 0))))))' "$release/compose.json" >/dev/null 2>&1 || { compoza_fail 'Invalid archived Compose launch metadata; redeploy with the current CLI'; return 1; }
}

# Runs Compose in a clean process using JSON strings as individual arguments, never shell code.
compoza_compose_inner() {
  local release=$1 name value arg
  shift
  compoza_metadata "$release" || return 1
  local prefix=(docker compose) args=()
  while IFS= read -r -d '' arg; do prefix+=("$arg"); done < <(jq -j '.arguments[] | ., "\u0000"' "$release/compose.json")
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do export "$name=$value"; done < <(jq -j '.images[] | .name, "\u0000", .value, "\u0000"' "$release/compose.json")
  if [ "$COMPOZA_SECRET_FILE" != '-' ]; then
    if [ "$COMPOZA_SECRET_REQUIRED" = yes ]; then [ -f "$COMPOZA_SECRET_FILE" ] || { compoza_fail 'Configured secret file is missing'; return 1; }; fi
    if [ -f "$COMPOZA_SECRET_FILE" ]; then args+=(--env-file "$COMPOZA_SECRET_FILE"); fi
  fi
  args+=(--env-file "$release/release.env")
  if [ "${1-}" != config ] && ! "${prefix[@]}" "${args[@]}" config --quiet >/dev/null 2>&1; then compoza_fail 'Compose configuration is invalid; inspect host env and overlay privately'; return 1; fi
  "${prefix[@]}" "${args[@]}" "$@"
}

compoza_compose_release() {
  env -i HOME="$HOME" USER="${USER-}" PATH="$PATH" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR-}" DOCKER_HOST="${DOCKER_HOST-}" DOCKER_CONTEXT="${DOCKER_CONTEXT-}" DOCKER_CONFIG="${DOCKER_CONFIG-$HOME/.docker}" COMPOZA_SECRET_FILE="$secret_file" COMPOZA_SECRET_REQUIRED="$secret_required" bash "$candidate/runtime.sh" compose-inner "$candidate" "$@"
}

# Redacts service labels using private snapshot values, and projects only operational fields.
compoza_compose_safe() {
  if [ "$secret_managed" != yes ]; then compoza_compose_release "$@"; return; fi
  case "${1-}" in
    ps) compoza_compose_release "$@" --format json 2>/dev/null | jq -c --rawfile snapshot "$secret_file" -f "$candidate/status.jq" 2>/dev/null || { compoza_fail 'Cannot safely read deployed status; diagnostics suppressed'; return 1; };;
    logs) compoza_compose_release "$@" 2>/dev/null;;
    config) compoza_compose_release "$@";;
    *) if ! compoza_compose_release "$@" >/dev/null 2>&1; then compoza_fail 'Compose action failed; secret-bearing diagnostics suppressed'; return 1; fi;;
  esac
}

# Tests the platform's rename option on disposable symlinks before choosing the sole commit operation.
# Neither accepted option may follow a destination symlink into its target directory.
compoza_mv_mode() {
  local probe="$root/.deploy-lock/move-probe" mode result=no
  case "$(uname -s)" in Darwin) mode=-h;; Linux) mode=-T;; *) compoza_fail 'Unsupported atomic symlink replacement platform'; return 1;; esac
  mkdir "$probe" "$probe/one" "$probe/two" || return 1
  if ln -s one "$probe/current" && ln -s two "$probe/next" &&
    mv "$mode" "$probe/next" "$probe/current" &&
    [ -L "$probe/current" ] && [ "$(readlink "$probe/current")" = two ] &&
    [ ! -e "$probe/one/next" ] && [ ! -L "$probe/one/next" ]; then result=yes; fi
  # Only this invocation's empty probe paths can exist here, even if mv followed a symlink.
  rm -f "$probe/current" "$probe/next" "$probe/one/next"
  rmdir "$probe/one" "$probe/two" "$probe" || return 1
  [ "$result" = yes ] || return 1
  move_mode=$mode
}

compoza_promote() {
  local activation record next_current next_previous
  activation=$(LC_ALL=C od -An -N16 -tx1 /dev/urandom | tr -d ' \n') || return 1
  [[ "$activation" =~ ^[a-f0-9]{32}$ ]] || return 1
  record="$root/.activations/$activation"
  mkdir "$record" || return 1
  jq -n --arg path "$secret_file" --arg required "$secret_required" --arg managed "$secret_managed" '{path: (if $path == "-" then null else $path end), required: ($required == "yes"), managed: ($managed == "yes")}' > "$record/secret-source.json"
  ln -s "../../releases/${candidate##*/}" "$record/release"
  if [ "$release_id" != '-' ]; then ln -s "../../releases/$release_id" "$record/previous"; fi
  ln -s release/manifest.json "$record/manifest.json"
  # The dispatcher is ordinary versioned source, with the root passed as a quoted shell argument.
  { printf '#!/usr/bin/env bash\nset -euo pipefail\n'; printf 'exec bash %q recover %q "$@"\n' "$candidate/runtime.sh" "$root"; } > "$record/compose.sh"
  next_current="$root/.current-$activation"
  ln -s ".activations/$activation" "$next_current"
  mv "$move_mode" "$next_current" "$root/current"
  next_previous="$root/.previous-$activation"
  if ln -s current/previous "$next_previous" && mv "$move_mode" "$next_previous" "$root/previous"; then :; else compoza_fail 'Current activated; previous compatibility alias unavailable; use current/previous'; fi
}

compoza_activate() {
  local timeout=$1 pull=$2 promote=$3 validation_log validation_hint
  compoza_supported || return 1
  compoza_mv_mode || { compoza_fail 'Atomic symlink replacement is unavailable; refusing Compose mutation'; return 1; }
  validation_log="$candidate/validation.log"
  validation_hint="inspect $candidate/validation.log on the host"
  if [ "$secret_managed" = yes ]; then validation_log=/dev/null; validation_hint='secret-bearing diagnostics suppressed'; fi
  [ ! -L "$candidate/validation.log" ] || { compoza_fail 'Unsafe validation log'; return 1; }
  echo 'Validating candidate Compose configuration'
  if ! compoza_compose_release config --quiet >"$validation_log" 2>&1; then compoza_fail "Compose validation failed; $validation_hint"; return 1; fi
  if ! compoza_compose_release config --format json --no-env-resolution --no-path-resolution 2>>"$validation_log" | compoza_validate_model >>"$validation_log" 2>&1; then compoza_fail "Unsafe Compose paths; $validation_hint"; return 1; fi
  bash "$candidate/directories.sh"
  echo 'Starting stack and waiting for running/healthy services'
  if ! compoza_compose_release up --detach --remove-orphans --no-build --pull "$pull" --wait --wait-timeout "$timeout" >/dev/null 2>&1; then compoza_fail 'Compose failed: containers may be partially updated; previous current is unchanged. Recover with a release compose.sh or rollback.'; return 1; fi
  bash "$candidate/route.sh"
  bash "$candidate/health.sh"
  if [ "${candidate##*/}" != "$release_id" ] || [ "$promote" = yes ]; then
    printf '%s\n' successful > "$candidate/successful"
    compoza_promote
  else echo 'Reapplied current release; predecessor retained'; fi
  echo "Activated release ${candidate##*/}"
}

# Direct recovery always resolves the live activation source, including when an older release is selected.
compoza_recover() {
  root=$1; shift
  compoza_read_state || return 1
  [ "$release_id" != '-' ] || { compoza_fail 'No deployed release'; return 1; }
  candidate="$root/releases/$release_id"
  compoza_supported || return 1
  if [ "${1-}" != config ] && ! compoza_compose_release config --quiet >/dev/null 2>&1; then compoza_fail 'Deployed Compose configuration is invalid; inspect host env and overlay privately'; return 1; fi
  compoza_compose_safe "$@"
}

# A release wrapper selects its own frozen config and the currently active secret source.
compoza_wrapper() {
  candidate=$1; shift
  root=${candidate%/releases/*}
  if [ "${COMPOZA_SECRET_FILE-legacy}" = legacy ]; then
    compoza_read_state || return 1
    if [ "$secret_file" = legacy ]; then
      [ "$release_id" = '-' ] || { compoza_fail 'Archived secret source is unknown; redeploy with an explicit secret source before lifecycle or rollback'; return 1; }
      secret_file=$(jq -er '.legacy.path' "$candidate/compose.json") || return 1
      secret_required=$(jq -er 'if .legacy.required then "yes" else "no" end' "$candidate/compose.json") || return 1
    fi
  else secret_file=$COMPOZA_SECRET_FILE; secret_required=${COMPOZA_SECRET_REQUIRED-yes}; fi
  compoza_metadata "$candidate" || return 1
  compoza_compose_release "$@"
}

if [ "${BASH_SOURCE[0]-}" = "$0" ]; then
  set -euo pipefail
  export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH
  operation=$1; shift
  case "$operation" in
    compose-inner) compoza_compose_inner "$@";;
    compose) compoza_wrapper "$@";;
    recover) compoza_recover "$@";;
    *) compoza_fail 'Unknown host runtime operation'; exit 1;;
  esac
fi
