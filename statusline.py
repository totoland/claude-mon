#!/usr/bin/env python3
"""Claude Code status line: model | ctx% | 5h% | 7d% | tok/s (last, avg, sparkline).

tok/s is derived from the session transcript: for each API response (message.id),
output_tokens / (last chunk timestamp - preceding user/tool_result timestamp).
That window includes time-to-first-token, so it's end-to-end throughput.

Usage:
  statusline.py              status line only
  statusline.py --log        status line + append each finished response to LOG_PATH
  statusline.py --report     summarize LOG_PATH (by model, effort, fast mode, hour)
"""
import json, os, sys
from collections import defaultdict
from datetime import datetime

TAIL_BYTES = 400_000   # only parse the end of the transcript -> stays fast on huge sessions
WINDOW = 10            # responses used for avg + sparkline
MIN_TOKENS = 20        # ignore tiny responses; their tok/s is noise
SPARK = "▁▂▃▄▅▆▇█"
DEBUG_DUMP = os.environ.get("CLAUDE_STATUSLINE_DUMP")  # path: dump raw stdin for inspection
LOG_DIR = os.path.expanduser(os.environ.get("CLAUDE_TOKRATE_DIR", "~/.claude/tokrate"))
LOG_PATH = os.path.join(LOG_DIR, "log.jsonl")
STATE_DIR = os.path.join(LOG_DIR, "state")  # per-session high-water mark, avoids duplicate rows

DIM, RST = "\033[2m", "\033[0m"
GRN, YEL, RED, CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def read_tail(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - TAIL_BYTES))
        lines = f.read().decode("utf-8", "ignore").splitlines()
    return lines[1:] if size > TAIL_BYTES else lines  # drop partial first line


def responses(path):
    """Per API response, oldest first: dict(id, model, start, end, out, thinking, done).

    `done` is True once a later user/system entry exists, i.e. the response has
    finished streaming; only finished responses get logged.
    """
    msgs, order = {}, []
    last_input_ts = None
    for line in read_tail(path):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t, stamp = d.get("type"), d.get("timestamp")
        if not stamp or d.get("isSidechain"):
            continue
        if t in ("user", "system"):
            for mid in order[-1:]:
                msgs[mid]["done"] = True
            if t == "user":
                last_input_ts = ts(stamp)
        elif t == "assistant":
            m = d.get("message") or {}
            mid, usage = m.get("id"), m.get("usage") or {}
            if not mid or last_input_ts is None:
                continue
            if mid not in msgs:
                msgs[mid] = {"id": mid, "model": m.get("model"), "start": last_input_ts,
                             "end": ts(stamp), "out": 0, "thinking": 0, "done": False}
                order.append(mid)
            rec = msgs[mid]
            rec["end"] = max(rec["end"], ts(stamp))
            rec["out"] = max(rec["out"], usage.get("output_tokens") or 0)
            think = (usage.get("output_tokens_details") or {}).get("thinking_tokens") or 0
            rec["thinking"] = max(rec["thinking"], think)
    out = []
    for mid in order:
        r = msgs[mid]
        r["dur"] = r["end"] - r["start"]
        if r["out"] >= MIN_TOKENS and r["dur"] > 0.2:
            out.append(r)
    return out


def log_responses(data, rows):
    """Append finished, not-yet-logged responses. Never raises into the status line."""
    sid = data.get("session_id")
    if not sid:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        state = os.path.join(STATE_DIR, sid)
        try:
            with open(state) as f:
                hwm = float(f.read().strip() or 0)
        except (OSError, ValueError):
            hwm = 0.0
        new = [r for r in rows if r["done"] and r["end"] > hwm]
        if not new:
            return
        extra = {
            "session_id": sid,
            "project": os.path.basename((data.get("workspace") or {}).get("project_dir") or data.get("cwd") or ""),
            "effort": dig(data, "effort", "level"),
            "fast_mode": data.get("fast_mode"),
            "cc_version": data.get("version"),
        }
        lines = "".join(json.dumps({
            "ts": datetime.fromtimestamp(r["end"]).astimezone().isoformat(timespec="seconds"),
            "msg_id": r["id"],
            "model": r["model"] or dig(data, "model", "id"),
            "output_tokens": r["out"],
            "thinking_tokens": r["thinking"],
            "duration_s": round(r["dur"], 3),
            "tok_s": round(r["out"] / r["dur"], 1),
            **extra,
        }) + "\n" for r in new)
        # O_APPEND + single write keeps lines intact across concurrent sessions
        fd = os.open(LOG_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, lines.encode())
        finally:
            os.close(fd)
        with open(state, "w") as f:
            f.write(str(max(r["end"] for r in new)))
    except OSError:
        pass


def color_pct(p):
    if p is None:
        return f"{DIM}--{RST}"
    c = GRN if p < 50 else YEL if p < 80 else RED
    return f"{c}{p:.0f}%{RST}"


def dig(d, *keys):
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def spark(vals):
    if not vals:
        return ""
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1
    return "".join(SPARK[int((v - lo) / span * (len(SPARK) - 1))] for v in vals)


def pctl(vals, q):
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * len(s)))]


def report():
    try:
        with open(LOG_PATH) as f:
            rows = [json.loads(l) for l in f if l.strip()]
    except OSError:
        sys.exit(f"no log yet at {LOG_PATH} — enable with: statusline.py --log")
    if not rows:
        sys.exit("log is empty")

    def table(title, keyfn):
        groups = defaultdict(list)
        for r in rows:
            groups[keyfn(r)].append(r)
        print(f"\n{title}")
        print(f"  {'group':<24}{'n':>6}{'avg':>8}{'p50':>8}{'p10':>8}{'p90':>8}{'tokens':>10}")
        for k in sorted(groups, key=str):
            g = groups[k]
            rates = [r["tok_s"] for r in g]
            # weighted avg = total tokens / total time, matches the status line avg
            avg = sum(r["output_tokens"] for r in g) / sum(r["duration_s"] for r in g)
            print(f"  {str(k):<24}{len(g):>6}{avg:>8.0f}{pctl(rates, .5):>8.0f}"
                  f"{pctl(rates, .1):>8.0f}{pctl(rates, .9):>8.0f}{sum(r['output_tokens'] for r in g):>10}")

    print(f"{len(rows)} responses  {rows[0]['ts']}  →  {rows[-1]['ts']}   (tok/s, end-to-end)")
    table("by model", lambda r: r["model"])
    table("by model + effort", lambda r: f"{r['model']} / {r.get('effort')}")
    table("by fast mode", lambda r: f"fast={r.get('fast_mode')}")
    table("by hour (local)", lambda r: r["ts"][11:13] + ":00")
    table("by day", lambda r: r["ts"][:10])


def main():
    if "--report" in sys.argv:
        return report()

    raw = sys.stdin.read()
    if DEBUG_DUMP:
        with open(DEBUG_DUMP, "w") as f:
            f.write(raw)
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        data = {}

    parts = []
    model = dig(data, "model", "display_name")
    if model:
        parts.append(f"{CYN}{model}{RST}")

    ctx = dig(data, "context_window", "used_percentage")
    parts.append(f"ctx {color_pct(ctx)}")

    rl = data.get("rate_limits") or {}
    for label, key in (("5h", "five_hour"), ("7d", "seven_day")):
        p = dig(rl, key, "used_percentage")
        if p is not None:
            parts.append(f"{label} {color_pct(p)}")

    tp_path = data.get("transcript_path")
    if tp_path and os.path.exists(tp_path):
        try:
            all_rows = responses(tp_path)
        except Exception:
            all_rows = []
        if "--log" in sys.argv:
            log_responses(data, all_rows)
        rows = all_rows[-WINDOW:]
        if rows:
            rates = [r["out"] / r["dur"] for r in rows]
            last = rates[-1]
            avg = sum(r["out"] for r in rows) / sum(r["dur"] for r in rows)
            parts.append(
                f"⚡ {last:.0f} tok/s {DIM}avg {avg:.0f} {spark(rates)}{RST}"
            )
        else:
            parts.append(f"⚡ {DIM}-- tok/s{RST}")

    print(f" {DIM}│{RST} ".join(parts))


if __name__ == "__main__":
    main()
