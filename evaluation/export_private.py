#!/usr/bin/env python3
"""Export one original Transcript to a new private evaluation draft, never to stdout.

Both the app database and destination must be outside this repository, including
through symlinks. The database is opened read-only; existing outputs are never replaced.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sqlite3
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent


def private_path(value: str | Path, *, existing: bool) -> Path:
    lexical = Path(os.path.abspath(os.path.expanduser(value)))
    root = REPO_ROOT.resolve()
    if lexical == root or lexical.is_relative_to(root):
        raise ValueError("Private database and output paths must be outside the repository")
    try:
        canonical = lexical.resolve(strict=existing)
    except (OSError, RuntimeError):
        raise ValueError("The private path could not be resolved safely") from None
    if canonical == root or canonical.is_relative_to(root):
        raise ValueError("Private paths must remain outside the repository through symlinks")
    if existing and not canonical.is_file():
        raise ValueError("The private database must be an existing file")
    return lexical


def export_private(database: str | Path, meeting: int, split: str, output: str | Path) -> None:
    if type(meeting) is not int or meeting < 1 or split not in ("tuning", "reserved"):
        raise ValueError("Choose a positive Meeting ID and tuning or reserved split")
    source = private_path(database, existing=True).resolve(strict=True)
    destination = private_path(output, existing=False)
    try:
        parent = destination.parent.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError("The private output directory must already exist") from None
    if not parent.is_dir():
        raise ValueError("The private output directory must already exist")
    connection = None
    try:
        connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        row = connection.execute("SELECT state FROM meetings WHERE id = ?", (meeting,)).fetchone()
        if row is None:
            raise ValueError("That Meeting does not exist")
        if row[0] not in ("done", "failed"):
            raise ValueError("The Meeting's Transcript is still being processed or recorded")
        rows = connection.execute("SELECT start, end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx", (meeting,)).fetchall()
        if not rows:
            raise ValueError("The Meeting has no completed Transcript to export")
    except sqlite3.Error:
        raise ValueError("Could not read the app database in read-only mode") from None
    finally:
        if connection is not None:
            connection.close()
    segments = []
    previous_start = -math.inf
    for start, end, speaker, text in rows:
        if (not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start or start < previous_start
                or not isinstance(speaker, str) or not speaker.strip() or not isinstance(text, str)):
            raise ValueError("The stored Transcript contains an invalid segment; review it before export")
        segments.append({"start": start, "end": end, "speaker": speaker, "text": text})
        previous_start = start
    fixture = {"id": f"private-meeting-{meeting}", "synthetic": False, "split": split,
               "transcript": {"segments": segments}, "points": [], "questions": [], "expectationsPrepared": False}
    encoded = json.dumps(fixture, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    # Pin the already-resolved parent directory and refuse an existing leaf, including dangling symlinks.
    directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    created = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(destination.name, flags, 0o600, dir_fd=directory_fd)
        created = True
        with os.fdopen(descriptor, "w", encoding="utf8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        if created:
            os.unlink(destination.name, dir_fd=directory_fd)
        raise
    finally:
        os.close(directory_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--meeting", type=int, required=True)
    parser.add_argument("--split", choices=["tuning", "reserved"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        export_private(args.database, args.meeting, args.split, args.output)
    except FileExistsError:
        print("Export refused: the output already exists; choose a new private path.", file=sys.stderr)
        return 1
    except ValueError as problem:
        print(f"Export refused: {problem}", file=sys.stderr)
        return 1
    except OSError:
        print("Export failed: check the private file and directory permissions.", file=sys.stderr)
        return 1
    print("Exported a private draft. Prepare expected points and questions before evaluating it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
