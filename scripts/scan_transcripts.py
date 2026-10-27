"""Counts Claude Code activity per local day from the session transcripts.

Usage: python3 -I scan_transcripts.py <projects dir> <state file>

Prints one JSON object: {"days": {date: {...}}, "sessionHours": {date: {hour: n}}}.
The counting follows Claude Code's own stats cache: a message is any user,
assistant, attachment or system line; a tool call is a tool_use block; a
session counts on the day it started. Tokens are counted once per reply (the
cache counts them once per line of a reply, which repeats the same usage).

Transcripts only grow, so each file's counts are kept in the state file and
read again only when the file's size or modification time changed.
"""

import json
import os
import sys
from datetime import datetime

STATE_VERSION = 1
MESSAGE_TYPES = {"user", "assistant", "attachment", "system"}
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def local(timestamp):
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone()


def count_file(path):
    days = {}
    sessions = {}
    replies = {}
    seen = set()

    def day_of(date):
        return days.setdefault(date, {"messages": 0, "toolCalls": 0, "tokens": {}})

    with open(path, encoding="utf-8", errors="replace") as lines:
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") not in MESSAGE_TYPES:
                continue
            timestamp = entry.get("timestamp")
            if not isinstance(timestamp, str):
                continue
            uuid = entry.get("uuid")
            if uuid in seen:
                continue
            if uuid:
                seen.add(uuid)
            try:
                when = local(timestamp)
            except ValueError:
                continue
            date = when.strftime("%Y-%m-%d")
            counts = day_of(date)
            counts["messages"] += 1

            session = entry.get("sessionId")
            if isinstance(session, str) and (session not in sessions or timestamp < sessions[session]):
                sessions[session] = timestamp

            message = entry.get("message")
            if entry["type"] != "assistant" or not isinstance(message, dict):
                continue
            content = message.get("content")
            if isinstance(content, list):
                counts["toolCalls"] += sum(
                    1 for block in content if isinstance(block, dict) and block.get("type") == "tool_use"
                )
            usage = message.get("usage")
            if isinstance(usage, dict) and message.get("model"):
                total = sum(usage.get(key) or 0 for key in USAGE_KEYS)
                # A reply's lines repeat its usage: the last one stands for it.
                replies[message.get("id") or uuid] = (date, message["model"], total)

    for date, model, total in replies.values():
        if total > 0:
            tokens = day_of(date)["tokens"]
            tokens[model] = tokens.get(model, 0) + total

    return {"days": days, "sessions": sessions}


def transcripts(root):
    for folder, _, names in os.walk(root):
        for name in names:
            if name.endswith(".jsonl"):
                yield os.path.join(folder, name)


def load_state(path):
    try:
        with open(path, encoding="utf-8") as file:
            state = json.load(file)
        if state.get("version") == STATE_VERSION:
            return state
    except (OSError, ValueError):
        pass
    return {"version": STATE_VERSION, "files": {}}


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = f"{path}.{os.getpid()}.tmp"
    with open(partial, "w", encoding="utf-8") as file:
        json.dump(state, file)
    os.replace(partial, path)


def main(root, state_path):
    state = load_state(state_path)
    files = {}
    for path in transcripts(root):
        try:
            info = os.stat(path)
        except OSError:
            continue
        known = state["files"].get(path)
        if known and known["size"] == info.st_size and known["mtime"] == info.st_mtime:
            files[path] = known
            continue
        try:
            counted = count_file(path)
        except OSError as error:
            print(f"skipped {path}: {error}", file=sys.stderr)
            continue
        files[path] = {"size": info.st_size, "mtime": info.st_mtime, **counted}
    state["files"] = files
    save_state(state_path, state)

    days = {}
    starts = {}
    for counted in files.values():
        for date, counts in counted["days"].items():
            total = days.setdefault(date, {"messages": 0, "sessions": 0, "toolCalls": 0, "tokens": {}})
            total["messages"] += counts["messages"]
            total["toolCalls"] += counts["toolCalls"]
            for model, tokens in counts["tokens"].items():
                total["tokens"][model] = total["tokens"].get(model, 0) + tokens
        for session, timestamp in counted["sessions"].items():
            if session not in starts or timestamp < starts[session]:
                starts[session] = timestamp

    session_hours = {}
    for timestamp in starts.values():
        when = local(timestamp)
        date = when.strftime("%Y-%m-%d")
        days.setdefault(date, {"messages": 0, "sessions": 0, "toolCalls": 0, "tokens": {}})["sessions"] += 1
        hours = session_hours.setdefault(date, {})
        hours[str(when.hour)] = hours.get(str(when.hour), 0) + 1

    json.dump({"days": days, "sessionHours": session_hours}, sys.stdout)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: scan_transcripts.py <projects dir> <state file>")
    main(sys.argv[1], sys.argv[2])
