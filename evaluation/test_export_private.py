"""Read-only database export and privacy-path behavior using synthetic content only."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import export_private

TEXT = "Synthetic words that must never appear in console output."


class PrivateExportTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.repo = self.root / "repository"
        self.repo.mkdir()
        self.database = self.root / "app.db"
        self.output = self.root / "fixture.json"
        self.guard = patch.object(export_private, "REPO_ROOT", self.repo)
        self.guard.start()
        db = sqlite3.connect(self.database)
        db.executescript("CREATE TABLE meetings (id INTEGER PRIMARY KEY, state TEXT); CREATE TABLE segments (meeting_id INTEGER, idx INTEGER, start REAL, end REAL, speaker TEXT, text TEXT); CREATE TABLE participants (label TEXT, name TEXT);")
        db.execute("INSERT INTO meetings VALUES (1,'done')")
        db.execute("INSERT INTO participants VALUES ('Speaker 1','Renamed Person')")
        db.execute("INSERT INTO segments VALUES (1,10,10,12,'Speaker 1',?)", (TEXT,))
        db.execute("INSERT INTO segments VALUES (1,2,2,4,'You','First source segment')")
        db.commit()
        db.close()

    def tearDown(self):
        self.guard.stop()
        self.folder.cleanup()

    def run_export(self, database=None, output=None):
        export_private.export_private(database or self.database, 1, "reserved", output or self.output)

    def test_exports_original_labels_in_segment_order_as_an_unprepared_private_draft(self):
        before = self.database.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.run_export()
        fixture = json.loads(self.output.read_text())
        self.assertEqual(fixture, {"id": "private-meeting-1", "synthetic": False, "split": "reserved", "expectationsPrepared": False,
                                  "transcript": {"segments": [{"start": 2, "end": 4, "speaker": "You", "text": "First source segment"}, {"start": 10, "end": 12, "speaker": "Speaker 1", "text": TEXT}]}, "points": [], "questions": []})
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)

    def test_rejects_repository_source_or_output_even_when_the_source_symlink_points_outside(self):
        source_link = self.repo / "source.db"
        source_link.symlink_to(self.database)
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            self.run_export(database=source_link)
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            self.run_export(output=self.repo / "private.json")
        self.assertFalse(self.output.exists())

    def test_rejects_outside_symlinks_resolving_to_repository_sources_or_outputs(self):
        inside = self.repo / "inside.db"
        inside.write_bytes(self.database.read_bytes())
        source_link = self.root / "source.db"
        source_link.symlink_to(inside)
        with self.assertRaisesRegex(ValueError, "through symlinks"):
            self.run_export(database=source_link)
        parent_link = self.root / "linked-parent"
        parent_link.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "through symlinks"):
            self.run_export(output=parent_link / "draft.json")
        dangling = self.root / "dangling-output.json"
        dangling.symlink_to(self.repo / "not-created.json")
        with self.assertRaisesRegex(ValueError, "through symlinks"):
            self.run_export(output=dangling)
        self.assertFalse((self.repo / "not-created.json").exists())

    def test_never_overwrites_existing_output_or_follows_a_dangling_output_symlink(self):
        self.output.write_text("preserve this")
        with self.assertRaises(FileExistsError):
            self.run_export()
        self.assertEqual(self.output.read_text(), "preserve this")
        target = self.root / "not-created.json"
        link = self.root / "outside-dangling.json"
        link.symlink_to(target)
        with self.assertRaises(FileExistsError):
            self.run_export(output=link)
        self.assertFalse(target.exists())

    def test_rejects_incomplete_or_empty_transcripts_but_allows_summary_failure(self):
        db = sqlite3.connect(self.database)
        for state in ("recording", "processing"):
            db.execute("UPDATE meetings SET state=? WHERE id=1", (state,)); db.commit()
            with self.assertRaisesRegex(ValueError, "still being"):
                self.run_export()
        db.execute("UPDATE meetings SET state='failed' WHERE id=1"); db.commit()
        self.run_export()
        self.output.unlink()
        db.execute("DELETE FROM segments"); db.commit(); db.close()
        with self.assertRaisesRegex(ValueError, "no completed Transcript"):
            self.run_export()
        self.assertFalse(self.output.exists())

    def test_cli_never_prints_transcript_on_success_or_failure(self):
        script = str(Path(export_private.__file__).resolve())
        arguments = [sys.executable, script, "--database", str(self.database), "--meeting", "1", "--split", "tuning", "--output", str(self.output)]
        result = subprocess.run(arguments, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(TEXT, result.stdout + result.stderr)
        self.assertNotIn("First source segment", result.stdout + result.stderr)
        self.assertNotIn("Renamed Person", result.stdout + result.stderr)
        duplicate = subprocess.run(arguments, capture_output=True, text=True)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("output already exists", duplicate.stderr)
        self.assertNotIn(TEXT, duplicate.stdout + duplicate.stderr)

    def test_missing_source_does_not_create_a_database_or_output(self):
        absent = self.root / "missing.db"
        with self.assertRaises(ValueError):
            self.run_export(database=absent)
        self.assertFalse(absent.exists())
        self.assertFalse(self.output.exists())

    def test_rejects_invalid_segment_before_creating_the_output(self):
        db = sqlite3.connect(self.database)
        db.execute("UPDATE segments SET end=-1 WHERE idx=10"); db.commit(); db.close()
        with self.assertRaisesRegex(ValueError, "invalid segment"):
            self.run_export()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
