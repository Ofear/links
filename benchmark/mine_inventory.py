#!/usr/bin/env python3
"""Phase 0: mine session inventory from Claude Code history.

Scans ~/.claude/projects/**/*.jsonl (excluding subagents), extracts per-session
metadata, writes inventory.tsv. Raw material for benchmark question selection.

Columns: session_id, project, date, size_kb, user_turns, title
  title = session summary if present, else first real user message excerpt.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.home() / ".claude" / "projects"
OUT = Path(__file__).parent / "inventory.tsv"
MIN_SIZE_KB = 10  # skip near-empty sessions; they can't host benchmark answers
# Synthetic corpora that must never reach the index (claude-mem observer agents
# re-narrate primary sessions — indexing them would duplicate + pollute retrieval)
EXCLUDE_PROJECT_DIRS = {"-home-ofirh--claude-mem-observer-sessions"}
EXCERPT_LEN = 220


def clean(text: str) -> str:
    return " ".join(text.split())[:EXCERPT_LEN]


def first_user_text(obj) -> str | None:
    """Extract plain text from a user-message JSONL record, if any."""
    msg = obj.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = " ".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        return None
    text = text.strip()
    # skip harness-injected / command wrapper content — not a real user ask
    if not text or text.startswith("<"):
        return None
    return text


def scan_session(path: Path):
    size_kb = path.stat().st_size // 1024
    if size_kb < MIN_SIZE_KB:
        return None
    summary = None
    first_msg = None
    user_turns = 0
    first_ts = None
    try:
        with path.open(errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                if t == "summary" and summary is None:
                    summary = obj.get("summary")
                elif t == "user":
                    if obj.get("isMeta"):
                        continue
                    text = first_user_text(obj)
                    if text:
                        user_turns += 1
                        if first_msg is None:
                            first_msg = text
                if first_ts is None and obj.get("timestamp"):
                    first_ts = obj["timestamp"]
    except OSError as e:
        print(f"WARN unreadable {path}: {e}", file=sys.stderr)
        return None
    if user_turns == 0:
        return None
    if first_ts:
        date = first_ts[:10]
    else:
        date = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")
    title = clean(summary or first_msg or "")
    project = path.parent.name.removeprefix("-home-ofirh-").replace("-", "/")
    return (path.stem, project, date, size_kb, user_turns, title)


def main():
    rows = []
    skipped = 0
    for path in ROOT.rglob("*.jsonl"):
        if "subagents" in path.parts:
            continue
        if path.parent.name in EXCLUDE_PROJECT_DIRS:
            continue
        row = scan_session(path)
        if row:
            rows.append(row)
        else:
            skipped += 1
    rows.sort(key=lambda r: r[2], reverse=True)  # newest first
    with OUT.open("w") as f:
        f.write("session_id\tproject\tdate\tsize_kb\tuser_turns\ttitle\n")
        for r in rows:
            f.write("\t".join(str(x) for x in r) + "\n")
    print(f"{len(rows)} substantive sessions written to {OUT} ({skipped} skipped: tiny/empty/no-user-turns)")


if __name__ == "__main__":
    main()
