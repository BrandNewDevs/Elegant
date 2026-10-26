#!/usr/bin/env python3
"""Sample local command resources without saving its output, arguments or Meeting content.

RSS is a sum of resident sets, not unique physical memory. Model servers launched before
this command are outside its process tree; --include-ollama reports them separately.
"""
from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
import io
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import time


@dataclass(frozen=True)
class Process:
    pid: int
    ppid: int
    rss_kib: int
    command: str


def parse_ps(text: str) -> list[Process]:
    rows = []
    for line in text.splitlines():
        fields = line.split(None, 3)
        if len(fields) != 4:
            continue
        try:
            pid, ppid, rss = map(int, fields[:3])
        except ValueError:
            continue
        if pid > 0 and ppid >= 0 and rss >= 0:
            rows.append(Process(pid, ppid, rss, fields[3]))
    if text.strip() and not rows:
        raise ValueError("No valid process rows")
    return rows


def descendants(rows: list[Process], roots: set[int]) -> set[int]:
    children: dict[int, list[int]] = {}
    for row in rows:
        children.setdefault(row.ppid, []).append(row.pid)
    found, remaining = set(roots), list(roots)
    while remaining:
        for child in children.get(remaining.pop(), []):
            if child not in found:
                found.add(child)
                remaining.append(child)
    return found


def parse_linux_swap(text: str) -> int:
    values = {key: int(value) for key, value in re.findall(r"^(SwapTotal|SwapFree):\s+(\d+)\s+kB$", text, re.M)}
    if set(values) != {"SwapTotal", "SwapFree"} or values["SwapTotal"] < values["SwapFree"]:
        raise ValueError("Missing or inconsistent Linux swap counters")
    return values["SwapTotal"] - values["SwapFree"]


def parse_mac_swap(text: str) -> int:
    match = re.search(r"\bused\s*=\s*([\d.]+)\s*([KMGT])(?:B)?\b", text, re.I)
    if not match:
        raise ValueError("Missing macOS swap counter")
    return round(float(match[1]) * (1024 ** "KMGT".index(match[2].upper())))


def parse_vm_stat(text: str) -> dict[str, int]:
    size = re.search(r"page size of (\d+) bytes", text)
    if not size:
        raise ValueError("Missing VM page size")
    result = {"pageSizeBytes": int(size[1])}
    for label, key in (("Pageouts", "pageoutsPages"), ("Swapins", "swapInsPages"),
                       ("Swapouts", "swapOutsPages"), ("Pages occupied by compressor", "compressorPages")):
        match = re.search(r"^" + label + r":\s*(\d+)\.?\s*$", text, re.M)
        if match:
            result[key] = int(match[1])
    return result


def parse_nvidia(text: str) -> list[dict]:
    result = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) != 4:
            raise ValueError("Unexpected NVIDIA columns")
        index, name, used, total = [item.strip() for item in row]
        result.append({"index": int(index), "name": name, "usedMiB": float(used), "totalMiB": float(total)})
    return result


class Sampler:
    def __init__(self, include_ollama: bool = False, nvidia: bool = False):
        self.include_ollama, self.nvidia = include_ollama, nvidia
        self.warnings: set[str] = set()

    def tool(self, args: list[str]) -> str | None:
        try:
            return subprocess.run(args, capture_output=True, text=True, check=True, timeout=2).stdout
        except (OSError, subprocess.SubprocessError):
            self.warnings.add(f"{args[0]} unavailable or failed; its measurements are missing")
            return None

    def sample(self, pid: int) -> dict:
        sample: dict = {"processTreeRssKiB": None, "processTreeCount": None, "systemSwapUsedKiB": None}
        output = self.tool(["ps", "-axo", "pid=,ppid=,rss=,comm="])
        if output is not None:
            try:
                rows = parse_ps(output)
                pids = descendants(rows, {pid})
                members = [row for row in rows if row.pid in pids]
                if members:
                    sample.update(processTreeRssKiB=sum(row.rss_kib for row in members), processTreeCount=len(members))
                if self.include_ollama:
                    roots = {row.pid for row in rows if Path(row.command).name.lower().startswith("ollama")}
                    models = [row for row in rows if row.pid in descendants(rows, roots)]
                    sample["ollamaRssKiB"] = sum(row.rss_kib for row in models) if models else None
                    sample["ollamaProcessCount"] = len(models)
            except ValueError:
                self.warnings.add("Could not parse process measurements")
        try:
            if platform.system() == "Linux":
                sample["systemSwapUsedKiB"] = parse_linux_swap(Path("/proc/meminfo").read_text())
                counters = dict(line.split() for line in Path("/proc/vmstat").read_text().splitlines())
                sample["vm"] = {"pageSizeBytes": os.sysconf("SC_PAGE_SIZE"), "swapInsPages": int(counters["pswpin"]), "swapOutsPages": int(counters["pswpout"])}
            elif platform.system() == "Darwin":
                output = self.tool(["sysctl", "-n", "vm.swapusage"])
                if output is not None:
                    sample["systemSwapUsedKiB"] = parse_mac_swap(output)
                output = self.tool(["vm_stat"])
                if output is not None:
                    sample["vm"] = parse_vm_stat(output)
            else:
                self.warnings.add("System swap sampling supports Linux and macOS only")
        except (OSError, ValueError, KeyError):
            self.warnings.add("Could not read system swap or VM counters")
        if self.nvidia:
            output = self.tool(["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total", "--format=csv,noheader,nounits"])
            if output is not None:
                try:
                    sample["nvidia"] = parse_nvidia(output)
                except ValueError:
                    self.warnings.add("Could not parse NVIDIA measurements")
        return sample


def stop_group(process: subprocess.Popen, grace: float = 1.0) -> None:
    """Stop only the new process group owned by this wrapper, including orphaned descendants that remain in that group."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait()


def peak(samples: list[dict], key: str) -> int | None:
    values = [sample[key] for sample in samples if sample.get(key) is not None]
    return max(values) if values else None


def measure(command: list[str], *, interval: float = 0.5, label: str | None = None,
            timeout: float | None = None, sampler: Sampler | None = None) -> dict:
    if not command or not math.isfinite(interval) or interval <= 0 or (timeout is not None and (not math.isfinite(timeout) or timeout <= 0)) or label not in (None, "cold", "warm"):
        raise ValueError("Supply a command, positive intervals/timeout and an explicit cold/warm label if used")
    sampler = sampler or Sampler()
    started = time.monotonic()
    samples: list[dict] = []
    process = None
    status, code, error = "completed", None, None
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        while True:
            elapsed = time.monotonic() - started
            samples.append({"elapsedMs": round(elapsed * 1000, 1), **sampler.sample(process.pid)})
            if process.poll() is not None:
                break
            if timeout is not None and time.monotonic() - started >= timeout:
                status = "timed-out"
                break
            wait = interval if timeout is None else min(interval, max(0.001, timeout - (time.monotonic() - started)))
            try:
                process.wait(timeout=wait)
                break
            except subprocess.TimeoutExpired:
                pass
        code = process.poll()
        if code is not None and code != 0:
            status = "command-failed"
    except KeyboardInterrupt:
        status = "interrupted"
    except OSError as problem:
        status, error = "launch-failed", f"Command could not be started ({type(problem).__name__})"
    finally:
        elapsed_ms = round((time.monotonic() - started) * 1000, 1)
        if process is not None:
            stop_group(process)
    gpu_peaks: dict[str, float] = {}
    for sample in samples:
        for gpu in sample.get("nvidia", []):
            key = str(gpu["index"])
            gpu_peaks[key] = max(gpu_peaks.get(key, 0), gpu["usedMiB"])
    swap = [sample["systemSwapUsedKiB"] for sample in samples if sample.get("systemSwapUsedKiB") is not None]
    return {"version": 1, "status": status, "returnCode": code, "error": error,
            "runLabel": label or "unspecified", "executable": Path(command[0]).name,
            "hardware": {"system": platform.system(), "release": platform.release(), "machine": platform.machine(), "logicalCpus": os.cpu_count()},
            "elapsedMs": elapsed_ms, "requestedSampleIntervalSeconds": interval,
            "observations": {"peakProcessTreeRssKiB": peak(samples, "processTreeRssKiB"),
                             "peakOllamaRssKiB": peak(samples, "ollamaRssKiB"),
                             "peakNvidiaUsedMiBByDevice": gpu_peaks,
                             "initialSystemSwapUsedKiB": swap[0] if swap else None,
                             "peakSystemSwapUsedKiB": max(swap) if swap else None,
                             "lastSystemSwapUsedKiB": swap[-1] if swap else None},
            "scope": ["RSS sums can double count shared pages; they are not unique physical memory or a total device peak.",
                      "Existing model servers are outside the command process tree; optional Ollama measurements are separate and may overlap it.",
                      "System swap and GPU usage include other applications. Sampling can miss short-lived peaks.",
                      "Process-group cleanup cannot control a command that deliberately detaches into a new session.",
                      "The run label is operator supplied; the wrapper does not unload models or establish a cold/warm state.",
                      "Command output and arguments are not captured. These observations do not establish quality or M4 acceptance."],
            "warnings": sorted(sampler.warnings), "samples": samples}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", choices=["cold", "warm"])
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--timeout", type=float)
    parser.add_argument("--include-ollama", action="store_true")
    parser.add_argument("--nvidia", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("Supply the command after --")
    if not math.isfinite(args.interval) or args.interval <= 0 or (args.timeout is not None and (not math.isfinite(args.timeout) or args.timeout <= 0)):
        parser.error("Interval and timeout must be positive finite numbers")
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        result = measure(command, interval=args.interval, timeout=args.timeout, label=args.label,
                         sampler=Sampler(args.include_ollama, args.nvidia))
    finally:
        signal.signal(signal.SIGTERM, previous)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    if result["status"] == "completed":
        return 0
    if result["status"] == "command-failed" and result["returnCode"] is not None:
        return result["returnCode"] if result["returnCode"] > 0 else 128 - result["returnCode"]
    return {"interrupted": 130, "timed-out": 124, "launch-failed": 127}.get(result["status"], 1)


if __name__ == "__main__":
    raise SystemExit(main())
