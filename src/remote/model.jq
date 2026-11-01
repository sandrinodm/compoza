# Each record is [path, secret-policy, required, read-only]. All strings remain JSON data.
def entries($name):
  if has($name) then .[$name] | if type == "object" then . else error("invalid model section") end
  else {} end;
def path:
  if type == "string" and length > 0 and (explode | all(. >= 32)) then .
  else error("invalid path") end;
def file($secret; $required): [(. | path), $secret, $required, "no"];
(if length == 1 and (.[0] | type == "object") then .[0] else error("invalid model") end) |
(entries("services") | .[] | if type == "object" then . else error("invalid service") end |
  ((.volumes // [])[] | select(.type == "bind") |
    [(.source | path), "bind", "yes", (if .read_only == true then "yes" else "no" end)]),
  ((.env_file // [])[] |
    if type == "string" then file("yes"; "yes")
    else . as $entry | .path | file("yes"; if $entry.required == false then "no" else "yes" end) end)),
(entries("configs")[] | select(has("file")) | .file | file("no"; "yes")),
(entries("secrets")[] | select(has("file")) | .file | file("yes"; "yes"))
