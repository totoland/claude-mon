# claude-mon

Claude Code monitoring mods. Currently one plugin: **tokrate**.

## tokrate

Live throughput for every model response, under the prompt:

```
opus-5.5 │ ctx 6% │ 5h 29% │ 7d 40% │ ⚡ 106 tok/s · ttft 1.2s · avg 98 ▃▅▇
```

| Field | Meaning |
|---|---|
| `⚡ 106 tok/s` | generation speed of the last response: output tokens / (end − first token) |
| `ttft 1.2s` | time to first token of the last response |
| `avg 98 ▃▅▇` | weighted average and sparkline over the last 10 responses |
| `ctx` / `5h` / `7d` | context window fill and subscription rate-limit windows |

Measured live from the `turn.step` stream, not parsed from the transcript, so
generation speed and time to first token are separated.

### Install

At a Claude Code prompt:

```
/plugin install tokrate --marketplace totoland/claude-mon
```

Answer `y` to add the marketplace, then pick a scope. Start a new session.

### Report

Every response (subagents included, tagged `agent_id`) is appended to
`~/.claude/tokrate/log.jsonl`. In any session:

```
/tokrate
```

prints median generation tok/s, end-to-end tok/s, p10/p90 and median TTFT,
grouped by model, model + effort, fast mode, hour and day.

### Develop

```bash
claude plugin validate plugins/tokrate
claude plugin test plugins/tokrate
```

Requires `sh` for logging (macOS / Linux).

## statusline.py

The original standalone version: a `statusLine` command script that derives
end-to-end tok/s from the transcript. Useful where plugins aren't available.

```json
"statusLine": { "type": "command", "command": "python3 /path/to/statusline.py --log" }
```

`python3 statusline.py --report` summarizes the same log file.
