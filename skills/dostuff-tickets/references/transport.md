# Transport details

Only needed when `scripts/dostuff.sh` is unavailable or you must see the raw
HTTP exchange.

## Contents

- Manual discovery (registry file)
- Raw curl request
- Response framing (plain JSON vs SSE)
- Headless server (no VSCode)
- Script exit codes

## Manual discovery

Read the registry: `$DOSTUFF_REGISTRY_PATH` if set, else
`~/.config/dostuff/instances.json` (Linux/macOS) or
`%APPDATA%/dostuff/instances.json` (Windows). It is a JSON array of
`{workspacePath, port, pid, name, startedAt}`. Pick the entry whose
`workspacePath` is the longest path-prefix of your cwd; tie → newest
`startedAt`; no prefix match and exactly one entry → use it.

## Raw curl request

```
curl -sS -X POST http://127.0.0.1:<port>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Idempotency-Key: <random-uuid>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_ticket","arguments":{"query":"42"}}}'
```

No initialize handshake, no session header; every call is a one-shot POST.
The `Idempotency-Key` header is optional but lets you retry a timed-out write
without duplicating it (scoped per tool, 10-minute window). Resources use
`"method":"resources/read","params":{"uri":"dostuff://tickets"}`.

## Response framing

The body is either plain JSON or SSE:

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"workspace\":...}"}]},"jsonrpc":"2.0","id":1}
```

Concatenate the `data:` lines. The tool payload is the JSON string at
`result.content[0].text`; `result.isError: true` means that text is an error
message. Resource payloads sit at `result.contents[0].text` (`.blob` for
attachments).

## Headless server

Same DB, same API, same registry — no VSCode needed:

```sh
node "$DOSTUFF_SERVER_JS" serve --workspace /path/to/repo
# $DOSTUFF_SERVER_JS unset? It ships in the extension install — pick the newest:
ls -d ~/.vscode/extensions/*dostuff*/dist/server.cjs | tail -1
```

Suggest the command and let the user (or an approved agent step) run it. It
stays in the foreground and refuses a workspace another live instance already
serves (exit 3; `--takeover` for zombies).

## Script exit codes

| exit | meaning |
|---|---|
| 0 | request sent; payload or `ERROR: …` on stdout |
| 1 | transport failure or no instance matched; reason on stderr |
| 2 | local validation failed (cap, sha, range); no request sent |
