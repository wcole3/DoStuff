#!/bin/sh
# dostuff.sh — loopback client for the DoStuff MCP server.
#
#   discover                 print PORT<tab>WORKSPACE for the instance matching $PWD
#   call TOOL [JSON|-]       invoke an MCP tool ("-" reads the JSON arguments from stdin)
#   resource URI             read an MCP resource (e.g. dostuff://tickets)
#
# Env: DOSTUFF_PORT skips discovery; DOSTUFF_REGISTRY_PATH overrides the registry.
# The field caps in caps_for() mirror src/mcpLimits.ts — enforced locally (jq
# path only) so an over-long write fails fast instead of round-tripping.
set -u

die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

registry_path() {
  if [ -n "${DOSTUFF_REGISTRY_PATH:-}" ]; then printf '%s' "$DOSTUFF_REGISTRY_PATH"
  elif [ -n "${APPDATA:-}" ]; then printf '%s' "$APPDATA/dostuff/instances.json"
  else printf '%s' "$HOME/.config/dostuff/instances.json"; fi
}

discover() {
  if [ -n "${DOSTUFF_PORT:-}" ]; then printf '%s\t%s\n' "$DOSTUFF_PORT" "(DOSTUFF_PORT)"; return 0; fi
  reg=$(registry_path)
  [ -f "$reg" ] || die "No registry at $reg — is the DoStuff extension running with dostuff.mcp.enabled?"
  # The registry is always pretty-printed (one key per line), so a line-oriented
  # awk pass is enough. Longest workspacePath prefix of $PWD wins; ties go to
  # the newest startedAt; a single entry is the fallback when nothing matches.
  match=$(awk -v pwd="$PWD" '
    function norm(p) {
      gsub(/\\\\/, "/", p)                                    # JSON-escaped backslashes
      if (p ~ /^[A-Za-z]:\//) { p = tolower(p); p = "/" substr(p, 1, 1) substr(p, 3) }
      return p
    }
    /"workspacePath":/ { v = $0; sub(/^[^:]*:[ ]*"/, "", v); sub(/",?[ ]*$/, "", v); wp = v }
    /"port":/          { v = $0; gsub(/[^0-9]/, "", v); port = v }
    /"startedAt":/     { v = $0; sub(/^[^:]*:[ ]*"/, "", v); sub(/",?[ ]*$/, "", v); at = v }
    /^[ ]*}/ {
      if (wp != "" && port != "") { n++; wps[n] = wp; ports[n] = port; ats[n] = at }
      wp = ""; port = ""; at = ""
    }
    END {
      best = 0; bestlen = -1; bestat = ""
      for (i = 1; i <= n; i++) {
        p = norm(wps[i])
        c = pwd; if (p != wps[i]) c = tolower(pwd)            # windows entry: compare case-folded
        len = -1
        if (c == p) len = length(p) + 1
        else if (index(c, p "/") == 1) len = length(p)
        if (len >= 0 && (len > bestlen || (len == bestlen && ats[i] > bestat))) {
          best = i; bestlen = len; bestat = ats[i]
        }
      }
      if (best == 0 && n == 1) best = 1
      if (best == 0) exit 1
      printf "%s\t%s\n", ports[best], wps[best]
    }' "$reg") || die "No DoStuff instance matches $PWD.
Registry ($reg):
$(cat "$reg")
Hint: set DOSTUFF_PORT, or open this workspace in VSCode with dostuff.mcp.enabled."
  printf '%s\n' "$match"
}

# field:max pairs per tool — mirror of FIELD_LIMITS (src/mcpLimits.ts).
caps_for() {
  case "$1" in
    create_ticket)             echo "title:200 description:10000 verifyCriteria:10000 tasks:500 tags:64" ;;
    update_ticket_status)      echo "note:2000" ;;
    update_ticket_progress)    echo "recordEntry:500" ;;
    update_ticket_draft)       echo "tags:64 tasks:500" ;;
    update_ticket_description) echo "description:10000 note:500" ;;
    request_ticket_close | request_ticket_complete) echo "note:500" ;;
    *) echo "" ;;
  esac
}

check_caps() { # $1=tool $2=args-json — requires jq; longest string (or array element) per field
  for pair in $(caps_for "$1"); do
    f=${pair%%:*} max=${pair##*:}
    len=$(printf '%s' "$2" | jq --arg f "$f" '
      (.[$f] // empty) as $v
      | if ($v | type) == "string" then ($v | length)
        elif ($v | type) == "array" then
          ([$v[] | if type == "string" then length
                   elif type == "object" then ((.text // "") | length)
                   else 0 end] | max // 0)
        else 0 end')
    [ -n "$len" ] || len=0
    [ "$len" -le "$max" ] 2>/dev/null || \
      die "field $f exceeds $max chars ($len) — write terse: trim, do not truncate. No request sent." 2
  done
  case "$1" in
    update_ticket_progress)
      commit=$(printf '%s' "$2" | jq -r '.commit // empty')
      [ -z "$commit" ] || printf '%s' "$commit" | grep -Eq '^[0-9a-fA-F]{7,40}$' || \
        die "commit must be a git sha of 7-40 hex chars. No request sent." 2 ;;
    get_ticket)
      rl=$(printf '%s' "$2" | jq -r '.recordLimit // empty')
      case "$rl" in "" | *[!0-9]*) : ;; *) [ "$rl" -le 500 ] || \
        die "recordLimit must be 0-500. No request sent." 2 ;; esac ;;
    list_issues)
      lim=$(printf '%s' "$2" | jq -r '.limit // empty')
      case "$lim" in "" | *[!0-9]*) : ;; *) { [ "$lim" -ge 1 ] && [ "$lim" -le 250 ]; } || \
        die "limit must be 1-250. No request sent." 2 ;; esac ;;
  esac
}

post() { # $1=JSON-RPC body
  port=${DOSTUFF_PORT:-}
  if [ -z "$port" ]; then
    line=$(discover) || exit $?
    port=${line%%"$(printf '\t')"*}
  fi
  timeout=${DOSTUFF_TIMEOUT:-15}
  resp=$(curl -sS --max-time "$timeout" -X POST "http://127.0.0.1:${port}/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data-binary "$1" 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || transport_die "$port" "$rc" "$timeout" "$resp"
  unwrap "$resp"
}

# curl failed: say what the exit code actually means. A blanket "cannot
# reach" sent people after stale registry entries when the extension host
# was merely stalled (one blocked event loop can't answer HTTP either).
transport_die() { # $1=port $2=curl exit code $3=timeout seconds $4=curl output
  case "$2" in
    7)  die "Nothing is listening at 127.0.0.1:$1 — extension not running, dostuff.mcp.enabled off, or a stale registry entry. Re-run discover. ($4)" ;;
    28) die "DoStuff at 127.0.0.1:$1 did not answer within ${3}s — the extension host is busy (large sync or persist), not gone. Retry shortly; raise DOSTUFF_TIMEOUT if it recurs. ($4)" ;;
    52) die "DoStuff at 127.0.0.1:$1 accepted the connection but sent an empty reply — the extension host was likely stalled and dropped it. Retry shortly. ($4)" ;;
    *)  die "Cannot reach DoStuff at 127.0.0.1:$1 (curl exit $2). ($4)" ;;
  esac
}

unwrap() { # SSE or plain-JSON HTTP body -> tool payload (raw JSON-RPC when jq is absent)
  msg=$(printf '%s\n' "$1" | awk '/^data:/ { sub(/^data:[ ]?/, ""); print }')
  [ -n "$msg" ] || msg=$1
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$msg" | jq -rs '
      [.[] | select(type == "object" and has("id"))] | last as $m
      | if $m == null then "ERROR: empty response"
        elif $m.error then "ERROR: " + ($m.error | tojson)
        elif ($m.result.isError // false) then "ERROR: " + ($m.result.content[0].text // "unknown")
        else ($m.result.content[0].text // $m.result.contents[0].text // ($m.result | tojson))
        end'
  else
    printf '%s\n' "$msg"
  fi
}

call() {
  tool=${1:?usage: dostuff.sh call TOOL [JSON|-]}
  args=${2:-"{}"}
  [ "$args" = "-" ] && args=$(cat)
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$args" | jq -e . >/dev/null 2>&1 || die "Arguments are not valid JSON: $args"
    check_caps "$tool" "$args"
    body=$(jq -cn --arg name "$tool" --argjson a "$args" \
      '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $name, arguments: $a}}')
  else
    body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"'"$tool"'","arguments":'"$args"'}}'
  fi
  post "$body"
}

resource() {
  uri=${1:?usage: dostuff.sh resource URI}
  if command -v jq >/dev/null 2>&1; then
    body=$(jq -cn --arg uri "$uri" '{jsonrpc: "2.0", id: 1, method: "resources/read", params: {uri: $uri}}')
  else
    body='{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"'"$uri"'"}}'
  fi
  post "$body"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  discover) discover ;;
  call)     call "$@" ;;
  resource) resource "$@" ;;
  *) die "usage: dostuff.sh discover | call TOOL [JSON|-] | resource URI" ;;
esac
