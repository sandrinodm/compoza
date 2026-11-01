# Connector bootstrap only: remote ingress configuration, DNS and Access remain separate operations.
umask 077

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null && command -v docker >/dev/null || fail 'Cloudflare provisioning requires host Docker and jq'

# Refuse symlinks in every stack path component, including a pre-existing parent.
path_cursor=$proxy_dir
while [ "$path_cursor" != / ]; do
  [ ! -L "$path_cursor" ] || fail 'Refusing symlinked Cloudflare stack directory'
  path_cursor=${path_cursor%/*}
  [ -n "$path_cursor" ] || path_cursor=/
done
mkdir -p "$proxy_dir"
cd "$proxy_dir"
mkdir .compoza-cloudflare.lock 2>/dev/null || fail 'Cloudflare provisioning is locked; inspect the owner before retrying'
printf 'pid=%s host=%s\n' "$$" "$(hostname)" > .compoza-cloudflare.lock/owner
stage=''

cleanup() {
  [ -z "$stage" ] || rm -rf "$stage"
  rm -f .compoza-cloudflare.lock/owner
  rmdir .compoza-cloudflare.lock
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
stage=$(mktemp -d "$PWD/.compoza-cloudflare.XXXXXX")
cat > "$stage/input.json"
jq -ej '.compose | strings' "$stage/input.json" > "$stage/compose.yaml"

[ ! -L "$compose_file" ] || fail 'Refusing symlinked Cloudflare Compose file'
if [ -e "$compose_file" ]; then
  [ -f "$compose_file" ] && cmp -s "$compose_file" "$stage/compose.yaml" ||
    fail 'Existing Cloudflare Compose file differs; preserve it and reconcile the template before retrying'
fi

docker info >"$stage/log" 2>&1 || fail 'Cannot reach host Docker'
if docker inspect "$container" > /dev/null 2>&1; then
  docker inspect "$container" > "$stage/container.json" 2>"$stage/log" || fail 'Cannot inspect Cloudflare container ownership'
  jq -e --arg project "$project" --arg service "$service" --arg dir "$PWD" '
    .[0].Config.Labels | .["com.docker.compose.project"] == $project and
    .["com.docker.compose.service"] == $service and .["com.docker.compose.project.working_dir"] == $dir
  ' "$stage/container.json" >/dev/null 2>&1 || fail 'Cloudflare container belongs to another stack; refusing replacement'
fi

if [ "$managed_credentials" = yes ] && [ -e "$env_file" ] && [ ! -f "$compose_file" ]; then
  fail 'Managed Cloudflare credential file exists without owned configuration; refusing replacement'
fi

# Install the nonsecret ownership marker before credentials so failed validation can be retried safely.
if [ ! -e "$compose_file" ]; then
  (set -C; cat "$stage/compose.yaml" > "$compose_file")
fi
cmp -s "$compose_file" "$stage/compose.yaml" || fail 'Cloudflare Compose file changed during provisioning'

if [ "$managed_credentials" = yes ]; then
  [ ! -L "$env_file" ] || fail 'Refusing symlinked Cloudflare credential file'
  [ ! -e "$env_file" ] || [ -f "$env_file" ] || fail 'Cloudflare credential target is not a regular file'
  jq -ej '.credentials | strings' "$stage/input.json" > "$stage/credentials.env" || fail 'Cloudflare credential provider returned no token'
  chmod 600 "$stage/credentials.env"
  mv -f "$stage/credentials.env" "$env_file"
fi
[ -f "$env_file" ] && [ ! -L "$env_file" ] && [ -r "$env_file" ] || fail 'Cloudflare envFile must already exist and be readable'
case "$(uname -s)" in
  Darwin) permissions=$(stat -f '%Lp' "$env_file");;
  *) permissions=$(stat -c '%a' "$env_file");;
esac
[ "$((8#$permissions & 077))" -eq 0 ] || fail 'Cloudflare envFile must have private owner-only permissions'

compose() {
  docker compose --project-name "$project" --project-directory "$PWD" --env-file /dev/null -f "$1" "${@:2}"
}

compose "$stage/compose.yaml" config --format json > "$stage/model.json" 2>"$stage/log" ||
  fail 'Cloudflare Compose validation failed; check the credential file and Compose 2.30+ privately'

# A pasted installation command is not a connector token. Check its embedded identity before starting anything.
jq -e --arg service "$service" --arg account "$cf_account" --arg tunnel "$cf_tunnel" '
  .services[$service].environment.TUNNEL_TOKEN | @base64d | fromjson |
  .a == $account and .t == $tunnel and (.s | type == "string" and length > 0)
' "$stage/model.json" >/dev/null 2>&1 || fail 'Cloudflare token is invalid or belongs to a different account/tunnel; supply only the connector token'

if ! docker network inspect "$network" >"$stage/log" 2>&1; then
  docker network create --internal "$network" >"$stage/log" 2>&1 ||
    docker network inspect "$network" >"$stage/log" 2>&1 || fail 'Cannot prepare shared Cloudflare network'
fi
if [ ! -e "$compose_file" ]; then
  (set -C; cat "$stage/compose.yaml" > "$compose_file")
fi
cmp -s "$compose_file" "$stage/compose.yaml" || fail 'Cloudflare Compose file changed during provisioning'
compose "$compose_file" up --detach --force-recreate --wait --wait-timeout "$wait_timeout" "$service" >"$stage/log" 2>&1 ||
  fail 'Cloudflare connector did not become healthy; inspect host credentials and connectivity privately, then retry setup-proxy'
echo 'Cloudflare connector provisioned; shared network and connection readiness verified'
