# All apps and setup commands coordinate on the proxy directory, not an app-specific lock.
umask 077
fail() { echo "$1" >&2; exit 1; }
[ ! -L sites ] && [ -d sites ] || fail 'Caddy sites must be an existing directory, not a symlink'
mkdir .compoza-caddy.lock 2>/dev/null || fail 'Caddy is locked; wait for the other operation or inspect the host before retrying'
lock="$PWD/.compoza-caddy.lock"
stage=''
changed=no
had_previous=no
reload() {
  docker exec "$container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >"$stage/log" 2>&1
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$changed" = yes ]; then
    # Keep the backup intact until both disk restoration and the recovery reload succeed.
    if [ "$had_previous" = yes ]; then
      if ! cp -p "$stage/previous" "$stage/restore" || ! mv -f "$stage/restore" "$file"; then
        echo "Caddy route restoration failed; lock and recovery files retained at $stage" >&2
        exit 1
      fi
    elif ! rm -f "$file"; then
      echo "Caddy route restoration failed; lock and recovery files retained at $stage" >&2
      exit 1
    fi
    if ! reload; then
      echo "Previous site file restored, but Caddy recovery reload failed; lock and private recovery files retained at $stage. Inspect Caddy before retrying." >&2
      exit 1
    fi
    echo 'Previous site file and running Caddy configuration restored' >&2
  fi
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cd sites
[ ! -L "$file" ] || fail 'Refusing a symlinked Caddy route'
[ ! -e "$file" ] || [ -f "$file" ] || fail 'Caddy route must be a regular file'
if [ "$action" = unroute ] && [ ! -f "$file" ]; then
  echo "no route file $file; nothing to remove"
  exit 0
fi
# Stage inside sites so the rename is on the same filesystem; the import glob cannot match this directory.
stage=$(mktemp -d "$PWD/.compoza-route.XXXXXX")
if [ -f "$file" ]; then cp -p "$file" "$stage/previous"; had_previous=yes; fi
if [ "$action" = route ]; then
  cat > "$stage/candidate"
  changed=yes
  mv -f "$stage/candidate" "$file"
else
  changed=yes
  rm -f "$file"
fi
# Reload validates and provisions inside the running process; a second validator could contend for module resources.
if ! reload; then
  fail 'Caddy reload failed; restoring the previous site file. Inspect configuration and Caddy diagnostics privately.'
fi
changed=no
echo "Caddy $action complete: $file"
