# Bootstrap only: preserve app routes, certificates, logs and operator-managed credentials on every run.
umask 077
fail() { echo "$1" >&2; exit 1; }
command -v jq >/dev/null || fail 'Caddy provisioning requires jq on the host'
command -v docker >/dev/null || fail 'Caddy provisioning requires Docker on the host'
if [ -n "$env_file" ]; then
  [ -f "$env_file" ] && [ -r "$env_file" ] || fail 'Caddy envFile must already exist and be readable on the host'
fi
mkdir -p "$proxy_dir"
cd "$proxy_dir"
mkdir .compoza-caddy.lock 2>/dev/null || fail 'Caddy provisioning is already locked; inspect the host before retrying'
stage=''
cleanup() {
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  rmdir .compoza-caddy.lock
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
stage=$(mktemp -d "$PWD/.compoza-caddy.XXXXXX")
cat > "$stage/input.json"
jq -ej '.compose | strings' "$stage/input.json" > "$stage/compose.yaml"
jq -ej '.caddyfile | strings' "$stage/input.json" > "$stage/Caddyfile"
for pair in "Caddyfile:Caddyfile" "$compose_file:compose.yaml"; do
  target=${pair%%:*}
  candidate=${pair#*:}
  [ ! -L "$target" ] || fail "Refusing symlinked Caddy configuration: $target"
  if [ -e "$target" ]; then
    [ -f "$target" ] && cmp -s "$target" "$stage/$candidate" ||
      fail "Existing $target differs from the provisioning configuration; preserve it and omit provision to integrate an existing proxy"
  fi
done
for directory in sites data config; do
  [ ! -L "$directory" ] || fail "Refusing symlinked Caddy directory: $directory"
  mkdir -p "$directory"
done
docker info >"$stage/log" 2>&1 || fail 'Cannot reach Docker on the host'
if docker inspect "$container" > /dev/null 2>&1; then
  owner=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>"$stage/log")
  owner_service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container" 2>"$stage/log")
  owner_dir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container" 2>"$stage/log")
  [ "$owner" = "$project" ] && [ "$owner_service" = "$service" ] && [ "$owner_dir" = "$PWD" ] ||
    fail 'The Caddy container belongs to another stack; refusing to replace it'
fi
compose() {
  docker compose --project-name "$project" --project-directory "$PWD" --env-file /dev/null -f "$1" "${@:2}"
}
compose "$stage/compose.yaml" config --quiet >"$stage/log" 2>&1 ||
  fail 'Caddy Compose validation failed; check the host env file and Compose version (raw env files require 2.30+)'
set --
if [ -n "$env_file" ]; then set -- --env-file "$env_file"; fi
docker run --rm "$@" --entrypoint caddy \
  -v "$stage/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$PWD/sites:/etc/caddy/sites:ro" \
  "$image" validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$stage/log" 2>&1 ||
  fail 'Caddy validation failed; check the image DNS modules, environment and existing site files privately'
if ! docker network inspect "$network" >"$stage/log" 2>&1; then
  docker network create "$network" >"$stage/log" 2>&1 ||
    docker network inspect "$network" >"$stage/log" 2>&1 || fail 'Could not create the shared Caddy network'
fi
# Never truncate an existing file, including a file created by an external writer after the comparison above.
if [ ! -e Caddyfile ]; then (set -C; cat "$stage/Caddyfile" > Caddyfile); fi
if [ ! -e "$compose_file" ]; then (set -C; cat "$stage/compose.yaml" > "$compose_file"); fi
cmp -s Caddyfile "$stage/Caddyfile" && cmp -s "$compose_file" "$stage/compose.yaml" ||
  fail 'Caddy files changed during provisioning; refusing to start'
compose "$compose_file" up -d --wait --wait-timeout 60 "$service" >"$stage/log" 2>&1 ||
  fail 'Caddy did not start successfully; generated files and persistent data are retained for inspection and retry'
echo 'Caddy provisioned; shared network, persistent storage and per-app sites are ready'
