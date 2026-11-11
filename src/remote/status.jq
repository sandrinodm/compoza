# Snapshots are tool-generated JSON-string dotenv. Parse values privately, never as shell code.
def escape_controls:
  explode | map(if . < 32 then ([.] | implode | tojson | .[1:-1]) else [.] | implode end) | join("");
# Only the variables that .compoza.json lists as secrets are redacted. A file from an older version
# has no list, so every value is redacted. Longest values go first so a short value that is part of
# a longer one cannot leave the rest of the longer one visible.
def values:
  ($metadata[0].secretNames // null) as $names |
  $snapshot | split("\n") | map(
    select(contains("="))
    | split("=")
    | {name: .[0], value: (.[1:] | join("=") | escape_controls | fromjson | gsub("\\$\\$"; "$"))}
    | select(.name as $name | $names == null or ($names | index($name)) != null)
    | .value
  ) | map(select(length > 0)) | unique | sort_by(length) | reverse;
def redact($values): reduce $values[] as $value (. ; split($value) | join("***"));
values as $values |
(if type == "array" then .[] else . end) |
{
  service: ((if (.Service | type) == "string" and (.Service | test("\\A[a-zA-Z0-9][a-zA-Z0-9_.-]*\\z")) then .Service else "(service)" end) | redact($values)),
  image: ((if (.Image | type) == "string" and (.Image | length) <= 512 and (.Image | test("\\A[a-zA-Z0-9][a-zA-Z0-9._-]*(:[0-9]+)?(/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?(@sha256:[a-fA-F0-9]{64})?\\z")) then .Image else "(image)" end) | redact($values)),
  state: (.State as $state | if ["running", "exited", "created", "restarting", "paused", "removing", "dead"] | index($state) then $state else "unknown" end),
  health: (.Health as $health | if ["healthy", "unhealthy", "starting", ""] | index($health) then $health else "unknown" end),
  exitCode: (if (.ExitCode | type) == "number" and (.ExitCode | floor) == .ExitCode then .ExitCode else null end)
}
