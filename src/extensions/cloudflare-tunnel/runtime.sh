# Host-only Cloudflare authentication never enters argv, stack assets or diagnostic output.
cf_error() { printf '%s\n' "$1" >&2; return 1; }
cf_tools() { command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; }
cf_auth() {
  export -n cf_token
  [ -f "$cf_token_file" ] && [ ! -L "$cf_token_file" ] && [ -r "$cf_token_file" ] || return 1
  cf_token=$(cat "$cf_token_file" 2>/dev/null) || return 1
  case "$cf_token" in ''|*[!a-zA-Z0-9._~+/=-]*) return 1;; esac
}
cf_request() {
  # --disable is first so a host curlrc cannot enable verbose logging or redirect authentication.
  local method=$1 suffix=$2 response
  shift 2
  response=$(printf 'header = "Authorization: Bearer %s"\n' "$cf_token" |
    curl --disable --silent --fail --proto '=https' --connect-timeout 10 --max-time 30 \
      --config - --request "$method" --header 'Content-Type: application/json' \
      --url "https://api.cloudflare.com/client/v4/accounts/$cf_account/cfd_tunnel/$cf_tunnel$suffix" "$@" 2>/dev/null) || return 1
  printf '%s' "$response" | jq -e '.success == true and .result != null' >/dev/null 2>&1 || return 1
  printf '%s' "$response"
}
cf_remote() {
  cf_info=$(cf_request GET '') || return 1
  printf '%s' "$cf_info" | jq -e '.result.config_src == "cloudflare" and .result.deleted_at == null' >/dev/null 2>&1
}
cf_state() {
  [ ! -L "$cf_state_dir" ] && [ -d "$cf_root" ] && [ ! -L "$cf_root" ] && [ -d "$cf_root/routes" ] && [ ! -L "$cf_root/routes" ]
}
cf_owner() {
  cf_owned='[]'
  [ ! -L "$cf_owner_file" ] || return 1
  if [ -e "$cf_owner_file" ]; then
    [ -f "$cf_owner_file" ] || return 1
    cf_owned=$(cat "$cf_owner_file" 2>/dev/null) || return 1
  fi
  printf '%s' "$cf_owned" | jq -e 'type == "array"' >/dev/null 2>&1
}
cf_available() {
  # Another project's pending journal also reserves its hostnames after an interrupted request.
  for cf_other in "$cf_root"/routes/*.json; do
    [ "$cf_other" != "$cf_owner_file" ] || continue
    [ ! -L "$cf_other" ] || return 1
    [ -e "$cf_other" ] || continue
    jq -e --argjson wanted "$cf_wanted" 'type == "array" and all(.[]; .hostname as $name | all($wanted[]; .hostname != $name))' "$cf_other" >/dev/null 2>&1 || return 1
  done
}
cf_merge() {
  printf '%s' "$cf_config" | jq -ce --argjson owned "$cf_owned" --argjson wanted "$cf_wanted" "$cf_merge_filter" 2>/dev/null
}
cf_probe() {
  if cf_tools; then echo cf_tools=yes; else echo cf_tools=no; return; fi
  if cf_auth; then echo cf_auth=yes; else echo cf_auth=no; return; fi
  if cf_state; then echo cf_state=yes; else echo cf_state=no; fi
  if cf_remote; then
    if printf '%s' "$cf_info" | jq -e '.result.status == "healthy"' >/dev/null 2>&1; then echo cf_tunnel=yes; else echo cf_tunnel=no; fi
  else echo cf_tunnel=no; return; fi
  cf_config=$(cf_request GET /configurations) || { echo cf_api=no; return; }
  echo cf_api=yes
  if cf_owner && cf_available && cf_candidate=$(cf_merge); then
    echo cf_ownership=yes
    if printf '%s\n%s' "$cf_config" "$cf_candidate" | jq -se '.[0].result.config == .[1].config' >/dev/null 2>&1; then
      echo cf_route=yes
    else echo cf_route=no; fi
  else echo cf_ownership=no; fi
}
cf_setup() {
  cf_tools || { cf_error 'Cloudflare Tunnel requires host curl and jq'; return 1; }
  cf_auth || { cf_error 'Cannot read a valid Cloudflare API token from the configured host file'; return 1; }
  cf_remote || { cf_error 'Cannot access an existing remotely managed Cloudflare Tunnel'; return 1; }
  [ ! -L "$cf_state_dir" ] && [ ! -L "$cf_root" ] && [ ! -L "$cf_root/routes" ] || return 1
  umask 077
  mkdir -p "$cf_root/routes"
  chmod 700 "$cf_root" "$cf_root/routes"
  echo 'Cloudflare Tunnel route storage ready; existing connector and DNS remain operator-managed'
}
cf_cleanup() {
  [ -z "${cf_work:-}" ] || rm -rf "$cf_work"
  rmdir "$cf_root/.lock" 2>/dev/null || true
}
cf_mutate() {
  cf_tools || { cf_error 'Cloudflare Tunnel requires host curl and jq'; return 1; }
  cf_auth || { cf_error 'Cannot read a valid Cloudflare API token from the configured host file'; return 1; }
  cf_state || { cf_error 'Run setup-proxy for Cloudflare Tunnel route storage first'; return 1; }
  umask 077
  mkdir "$cf_root/.lock" 2>/dev/null || { cf_error 'Cloudflare Tunnel configuration is locked; another app may be deploying'; return 1; }
  cf_work=''
  trap cf_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cf_work=$(mktemp -d "$cf_root/.work.XXXXXX")
  cf_remote || { cf_error 'Cannot access an existing remotely managed Cloudflare Tunnel'; return 1; }
  cf_owner || { cf_error 'Invalid Cloudflare route ownership journal'; return 1; }
  cf_available || { cf_error 'Hostname is reserved by another deployment or its journal is invalid'; return 1; }
  cf_config=$(cf_request GET /configurations) || { cf_error 'Cannot read Cloudflare Tunnel configuration'; return 1; }
  cf_candidate=$(cf_merge) || { cf_error 'Cloudflare route conflict or invalid configuration; no route changed'; return 1; }
  printf '%s' "$cf_candidate" > "$cf_work/request.json"
  # Persist both possible outcomes before PUT; a timeout may mean the API applied the change.
  printf '%s' "$cf_owned" | jq -c --argjson wanted "$cf_wanted" '. + $wanted | unique' > "$cf_work/journal.json"
  mv -f "$cf_work/journal.json" "$cf_owner_file"
  cf_latest=$(cf_request GET /configurations) || { cf_error 'Cannot recheck Cloudflare configuration; ownership retained for retry'; return 1; }
  if ! printf '%s\n%s' "$cf_config" "$cf_latest" | jq -se '.[0].result.version == .[1].result.version and .[0].result.config == .[1].result.config' >/dev/null 2>&1; then
    cf_error 'Cloudflare configuration changed concurrently; retry after other writers finish'; return 1
  fi
  if ! printf '%s\n%s' "$cf_config" "$cf_candidate" | jq -se '.[0].result.config == .[1].config' >/dev/null 2>&1; then
    cf_request PUT /configurations --data-binary "@$cf_work/request.json" >/dev/null || {
      cf_error 'Cloudflare update failed or its outcome is unknown; ownership retained for a safe retry'; return 1;
    }
  fi
  printf '%s' "$cf_wanted" > "$cf_work/journal.json"
  mv -f "$cf_work/journal.json" "$cf_owner_file"
  echo 'Cloudflare Tunnel application route updated'
}
