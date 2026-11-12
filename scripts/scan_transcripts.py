"""Counts Claude Code activity per local day from the session transcripts.

Usage: python3 -I scan_transcripts.py <projects dir> <state file> [<Headroom logs dir>]

Prints one JSON object:

    {"days": {date: {...}}, "sessionHours": {date: {hour: n}}, "lineRatio": n}

The counting follows Claude Code's own stats cache: a message is any user,
assistant, attachment or system line; a tool call is a tool_use block; a
session counts on the day it started. Unlike the cache, a reply's tokens count
once, though Claude Code writes a reply as one line per content block and
repeats its usage on each.

A line or a reply counts once over all the files: a forked or resumed session
starts its file with a copy of the parent's lines, ids and all.

Each day also says what Claude Code's cache would count from the same files
(`asCached`: each file on its own, a reply's tokens once per line). Set beside
the cache, it shows what the cache saw in files deleted since. `lineRatio` is
how many lines' worth of tokens the cache counts for each reply.

Given Headroom's logs, the requests Headroom forwarded that match no reply in
any transcript count as `hidden`: auto mode's safety checks, compaction,
titles. Of Headroom's numbers only those it copies from the API's response
are read (cache reads, cache writes, output tokens); its own estimates are not.

Transcripts only grow, so each file's counts are kept in the state file and
read again only when the file's size or modification time changed. A hidden
request stays in the state file after Headroom's logs rotate it away.
"""

import glob
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime

STATE_VERSION = 2
MESSAGE_TYPES = {"user", "assistant", "attachment", "system"}
# input, cache reads, cache writes, output: the order replies are stored in.
USAGE_KEYS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")
PERF = re.compile(
    r"\[(?P<id>hr_(?P<epoch>\d+)_\d+)\] PERF model=(?P<model>\S+) .*?"
    r" cache_read=(?P<read>\d+) cache_write=(?P<write>\d+) .*? tok_out=(?P<out>\d+)"
)
# Headroom proxies other tools too; their requests aren't Claude Code's.
CLIENT = re.compile(r" client=(\S+)")


def local(timestamp):
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone()


def count_file(path):
    """The file's lines and replies, each once, with what the cache would count."""
    messages = []
    replies = {}
    line_tokens = {}
    sessions = {}
    seen = set()

    with open(path, encoding="utf-8", errors="replace") as lines:
        for number, line in enumerate(lines):
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
                date = local(timestamp).strftime("%Y-%m-%d")
            except ValueError:
                continue

            session = entry.get("sessionId")
            if isinstance(session, str) and (session not in sessions or timestamp < sessions[session]):
                sessions[session] = timestamp

            message = entry.get("message")
            is_reply = entry["type"] == "assistant" and isinstance(message, dict)
            content = message.get("content") if is_reply else None
            tool_calls = (
                sum(1 for block in content if isinstance(block, dict) and block.get("type") == "tool_use")
                if isinstance(content, list)
                else 0
            )
            # A line without an id can't be told apart from a copy, so it counts as its own.
            messages.append([uuid or f"{path}:{number}", date, tool_calls])

            usage = message.get("usage") if is_reply else None
            if isinstance(usage, dict) and message.get("model"):
                counts = [usage.get(key) or 0 for key in USAGE_KEYS]
                model = message["model"]
                by_model = line_tokens.setdefault(date, {})
                by_model[model] = by_model.get(model, 0) + sum(counts)
                # A reply's lines repeat its usage: the last one stands for it.
                key = message.get("id") or uuid or f"{path}:{number}"
                replies[key] = [key, date, model, *counts]

    return {
        "messages": messages,
        "replies": list(replies.values()),
        "lineTokens": line_tokens,
        "sessions": sessions,
    }


def transcripts(root):
    for folder, _, names in os.walk(root):
        for name in names:
            if name.endswith(".jsonl"):
                yield os.path.join(folder, name)


def headroom_requests(log_dir):
    """Every request in Headroom's logs: {id: [epoch seconds, model, cache reads, cache writes, output]}."""
    requests = {}
    for path in sorted(glob.glob(os.path.join(glob.escape(log_dir), "proxy.log*"))):
        try:
            with open(path, encoding="utf-8", errors="replace") as lines:
                for line in lines:
                    if " PERF model=" not in line:
                        continue
                    match = PERF.search(line)
                    client = CLIENT.search(line)
                    # Token counting is free, and has no usage of its own.
                    if (
                        not match
                        or (client and client[1] != "claude-code")
                        or match["model"].startswith("passthrough")
                    ):
                        continue
                    requests[match["id"]] = [
                        int(match["epoch"]),
                        match["model"],
                        int(match["read"]),
                        int(match["write"]),
                        int(match["out"]),
                    ]
        except OSError as error:
            print(f"skipped {path}: {error}", file=sys.stderr)
    return requests


def hidden_requests(log_dir, replies, known):
    """The requests no transcript has a reply for, with those the logs no longer hold.

    A request and its reply share their cache reads, cache writes and output
    tokens: the API reports them, and Headroom and Claude Code copy them.
    """
    if not log_dir or not os.path.isdir(log_dir):
        return known
    logged = headroom_requests(log_dir)
    signatures = Counter((model, read, write, out) for _, _, model, _, read, write, out in replies)
    hidden = {request: row for request, row in known.items() if request not in logged}
    for request in sorted(logged):
        epoch, model, read, write, out = logged[request]
        signature = (model, read, write, out)
        if signatures[signature] > 0:
            signatures[signature] -= 1
        else:
            hidden[request] = [epoch, model, read + write + out]
    return hidden


def load_state(path):
    try:
        with open(path, encoding="utf-8") as file:
            state = json.load(file)
        if state.get("version") == STATE_VERSION:
            return state
    except (OSError, ValueError):
        pass
    return {"version": STATE_VERSION, "files": {}, "hidden": {}}


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = f"{path}.{os.getpid()}.tmp"
    with open(partial, "w", encoding="utf-8") as file:
        json.dump(state, file, separators=(",", ":"))
    os.replace(partial, path)


def new_day():
    return {
        "messages": 0,
        "sessions": 0,
        "toolCalls": 0,
        "tokens": {},
        "asCached": {"messages": 0, "toolCalls": 0, "tokens": {}},
    }


def add(tokens, model, n):
    tokens[model] = tokens.get(model, 0) + n


def main(root, state_path, log_dir=None):
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

    days = {}
    messages = {}
    replies = {}
    starts = {}
    line_total = 0
    reply_total = 0
    for counted in files.values():
        for key, date, tool_calls in counted["messages"]:
            cached = days.setdefault(date, new_day())["asCached"]
            cached["messages"] += 1
            cached["toolCalls"] += tool_calls
            messages.setdefault(key, (date, tool_calls))
        for date, by_model in counted["lineTokens"].items():
            for model, tokens in by_model.items():
                add(days.setdefault(date, new_day())["asCached"]["tokens"], model, tokens)
                line_total += tokens
        for reply in counted["replies"]:
            reply_total += sum(reply[3:])
            replies.setdefault(reply[0], reply)
        for session, timestamp in counted["sessions"].items():
            if session not in starts or timestamp < starts[session]:
                starts[session] = timestamp

    for date, tool_calls in messages.values():
        day = days.setdefault(date, new_day())
        day["messages"] += 1
        day["toolCalls"] += tool_calls
    for _, date, model, *counts in replies.values():
        if sum(counts) > 0:
            add(days.setdefault(date, new_day())["tokens"], model, sum(counts))

    session_hours = {}
    for timestamp in starts.values():
        when = local(timestamp)
        date = when.strftime("%Y-%m-%d")
        days.setdefault(date, new_day())["sessions"] += 1
        hours = session_hours.setdefault(date, {})
        hours[str(when.hour)] = hours.get(str(when.hour), 0) + 1

    hidden = hidden_requests(log_dir, replies.values(), state.get("hidden", {}))
    for epoch, model, tokens in hidden.values():
        date = datetime.fromtimestamp(epoch).astimezone().strftime("%Y-%m-%d")
        day = days.setdefault(date, new_day()).setdefault("hidden", {"calls": 0, "tokens": {}})
        day["calls"] += 1
        add(day["tokens"], model, tokens)

    save_state(state_path, {"version": STATE_VERSION, "files": files, "hidden": hidden})
    json.dump(
        {
            "days": days,
            "sessionHours": session_hours,
            "lineRatio": line_total / reply_total if reply_total else 1,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit("usage: scan_transcripts.py <projects dir> <state file> [<Headroom logs dir>]")
    main(*sys.argv[1:])
