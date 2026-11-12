"""Tests for scripts/scan_transcripts.py.

Run with: python3 -m unittest discover -s tests
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import scan_transcripts  # noqa: E402

# Noon UTC: the same local date in nearly every zone.
NOON = "2026-11-10T12:00:00.000Z"
DATE = datetime.fromisoformat(NOON.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
EPOCH = int(datetime.fromisoformat(NOON.replace("Z", "+00:00")).timestamp())


def usage(read, write, out, inp=2):
    return {
        "input_tokens": inp,
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": write,
        "output_tokens": out,
    }


def reply_lines(session, message_id, uuids, model, used):
    """One reply as Claude Code writes it: a line per content block, each repeating the usage."""
    blocks = [{"type": "thinking", "thinking": ""}, {"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]
    return [
        {
            "type": "assistant",
            "uuid": uuid,
            "sessionId": session,
            "timestamp": NOON,
            "message": {"id": message_id, "model": model, "content": [block], "usage": used},
        }
        for uuid, block in zip(uuids, blocks)
    ]


def prompt(session, uuid):
    return {"type": "user", "uuid": uuid, "sessionId": session, "timestamp": NOON, "message": {"content": "hi"}}


def perf(request, model, read, write, out, client="claude-code"):
    return (
        f"2026-11-10 12:00:01,000 - headroom.proxy - INFO - [{request}] PERF model={model} msgs=2 "
        f"tok_before=1 tok_after=1 tok_saved=0 cache_read={read} cache_write={write} cache_hit_pct=100 "
        f"opt_ms=1 total_ms=1 tok_out={out} ttfb_ms=0 savings=none transforms= client={client}\n"
    )


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.dir.name, "projects", "-repo")
        self.logs = os.path.join(self.dir.name, "logs")
        self.state = os.path.join(self.dir.name, "state", "scan-state.json")
        os.makedirs(self.root)
        os.makedirs(self.logs)

        parent = [prompt("a", "u1"), *reply_lines("a", "msg_1", ["u2", "u3"], "claude-opus-5-5", usage(1000, 100, 10))]
        # A fork starts with a copy of its parent's lines, then goes on.
        fork = [*parent, prompt("b", "u4"), *reply_lines("b", "msg_2", ["u5", "u6"], "claude-opus-5-5", usage(2000, 0, 20))]
        self.write("a.jsonl", parent)
        self.write("b.jsonl", fork)

    def tearDown(self):
        self.dir.cleanup()

    def write(self, name, entries):
        with open(os.path.join(self.root, name), "w", encoding="utf-8") as file:
            file.write("".join(json.dumps(entry) + "\n" for entry in entries))

    def scan(self, with_logs=True):
        out = io.StringIO()
        with redirect_stdout(out):
            scan_transcripts.main(os.path.dirname(self.root), self.state, self.logs if with_logs else None)
        return json.loads(out.getvalue())

    def test_a_fork_counts_its_parent_once_and_the_cache_way_twice(self):
        day = self.scan()["days"][DATE]

        self.assertEqual(day["messages"], 6)
        self.assertEqual(day["toolCalls"], 2)
        self.assertEqual(day["sessions"], 2)
        # Each reply once: 1112 for msg_1, 2022 for msg_2.
        self.assertEqual(day["tokens"], {"claude-opus-5-5": 3134})
        # As Claude Code's cache counts: each file on its own, a reply once per line.
        self.assertEqual(day["asCached"]["messages"], 9)
        self.assertEqual(day["asCached"]["toolCalls"], 3)
        self.assertEqual(day["asCached"]["tokens"], {"claude-opus-5-5": 2 * (2 * 1112 + 2022)})
        self.assertNotIn("hidden", day)

    def test_the_line_ratio_is_lines_of_tokens_per_reply(self):
        self.assertEqual(self.scan()["lineRatio"], 2)

    def test_headroom_requests_no_transcript_holds_count_as_hidden(self):
        with open(os.path.join(self.logs, "proxy.log"), "w", encoding="utf-8") as log:
            log.write(perf(f"hr_{EPOCH}_000001", "claude-opus-5-5", 1000, 100, 10))
            log.write(perf(f"hr_{EPOCH}_000002", "claude-sonnet-5", 5000, 50, 9))
            log.write(perf(f"hr_{EPOCH}_000003", "claude-opus-5-5", 2000, 0, 20))
            log.write(perf(f"hr_{EPOCH}_000004", "passthrough:count_tokens", 0, 0, 0))
            # Another tool behind the same proxy.
            log.write(perf(f"hr_{EPOCH}_000005", "gpt-5", 700, 0, 7, client="codex"))

        day = self.scan()["days"][DATE]
        self.assertEqual(day["hidden"], {"calls": 1, "tokens": {"claude-sonnet-5": 5059}})
        self.assertEqual(day["tokens"], {"claude-opus-5-5": 3134})

        # Rotated out of the logs, the hidden request still counts.
        os.remove(os.path.join(self.logs, "proxy.log"))
        self.assertEqual(self.scan()["days"][DATE]["hidden"]["calls"], 1)

    def test_without_headroom_logs_nothing_is_hidden(self):
        self.assertNotIn("hidden", self.scan(with_logs=False)["days"][DATE])
        os.rmdir(self.logs)
        self.assertNotIn("hidden", self.scan()["days"][DATE])

    def test_a_changed_file_is_counted_again(self):
        self.scan()
        self.write("a.jsonl", [prompt("a", "u1"), prompt("a", "u7")])
        day = self.scan()["days"][DATE]
        # u1 sits in both files; u7 is new; b.jsonl still has msg_1.
        self.assertEqual(day["messages"], 7)
        self.assertEqual(day["tokens"], {"claude-opus-5-5": 3134})


if __name__ == "__main__":
    unittest.main()
