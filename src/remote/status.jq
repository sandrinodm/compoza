# Snapshots are tool-generated JSON-string dotenv. Parse values privately, never as shell code.
def escape_controls:
  explode | map(if . < 32 then ([.] | implode | tojson | .[1:-1]) else [.] | implode end) | join("");
def values:
  $snapshot | split("\n") | map(select(contains("=")) | split("=") | .[1:] | join("=") | escape_controls | fromjson | gsub("\\$\\$"; "$")) | map(select(length > 0));
def redact($values): reduce $values[] as $value (. ; split($value) | join("***"));
values as $values |
(if type == "array" then .[] else . end) |
{
  service: ((if (.Service | type) == "string" and (.Service | test("^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")) then .Service else "(service)" end) | redact($values)),
  state: (.State as $state | if ["running", "exited", "created", "restarting", "paused", "removing", "dead"] | index($state) then $state else "unknown" end),
  health: (.Health as $health | if ["healthy", "unhealthy", "starting", ""] | index($health) then $health else "unknown" end),
  exitCode: (if (.ExitCode | type) == "number" and (.ExitCode | floor) == .ExitCode then .ExitCode else null end)
}
