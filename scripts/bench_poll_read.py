#!/usr/bin/env python3
"""Measure bytes read by the 250ms step-result event poller over a 10s run."""
from __future__ import annotations

import json
import os
import resource
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pi-poll-bench-") as temp:
        async_dir = Path(temp) / "run"
        async_dir.mkdir()
        event_file = async_dir / "events.jsonl"
        line = json.dumps({"type": "unrelated", "data": "x" * 1000}) + "\n"
        with event_file.open("w", encoding="utf-8") as stream:
            while event_file.stat().st_size < 2 * 1024 * 1024:
                stream.write(line)
        code = r'''
import { createStepResultEventBridge } from "./src/runs/background/step-result-events.ts";
const asyncDir = process.argv[1];
let handler;
const bridge = createStepResultEventBridge({
  runs: () => [{ asyncId: "bench", asyncDir, status: "running" }],
  events: { emit() {} },
  timers: { setInterval(fn) { handler = fn; return 1; }, clearInterval() {} },
});
let bytes = 0;
const end = Date.now() + 10_000;
while (Date.now() < end) {
  handler();
  bytes += bridge.bytesReadPerTick();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
}
bridge.dispose();
console.log(JSON.stringify({ bytesRead: bytes, elapsedMs: 10_000 }));
'''
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", code, str(async_dir)],
            cwd=ROOT, check=True, text=True, capture_output=True,
        )
        measured = json.loads(result.stdout.strip().splitlines()[-1])
        # ru_maxrss is KiB on Linux and bytes on macOS.
        rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        if os.uname().sysname == "Darwin":
            rss //= 1024
        print(f"bytes_read={measured['bytesRead']}")
        print(f"peak_rss_kb={rss}")


if __name__ == "__main__":
    main()
