# Reject malformed remote configuration and preserve unrelated rules and origin settings.
def valid_rule:
  type == "object" and (.hostname | type == "string") and (.service | type == "string")
  and (keys - ["hostname", "service", "originRequest"] | length == 0)
  and ((.originRequest // {}) == {});
def same_rule($a; $b): ($a + {originRequest: ($a.originRequest // {})}) == ($b + {originRequest: ($b.originRequest // {})});
(.result.config // {ingress: [{service: "http_status:404"}]}) as $config |
($config.ingress // [{service: "http_status:404"}]) as $rules |
if ($config | type) != "object" or ($rules | type) != "array" or ($rules | length) == 0
  or any($rules[]; type != "object" or (.service | type) != "string")
  or ($rules[-1].hostname != null) or ($rules[-1].path != null)
  or any($rules[0:-1][]; (.hostname | type) != "string")
  or ($owned | type) != "array" or any($owned[]; valid_rule | not)
  or ($wanted | type) != "array" or any($wanted[]; valid_rule | not)
then error("Unsupported tunnel configuration or ownership journal")
else
  ([$owned[], $wanted[]] | map(.hostname) | unique) as $domains |
  if any($rules[]; . as $rule | ($domains | index($rule.hostname)) != null
      and (any($owned[]; same_rule(.; $rule)) | not))
  then error("Hostname is not owned or was edited outside compoza")
  else {config: ($config + {ingress: ($wanted + [$rules[] | . as $rule | select(any($owned[]; same_rule(.; $rule)) | not)])})}
  end
end
