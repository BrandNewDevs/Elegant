"""Parser, missing-tool and real subprocess ownership checks for the benchmark wrapper."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from measure import Sampler, descendants, measure, parse_linux_swap, parse_mac_swap, parse_nvidia, parse_ps, parse_vm_stat


class MeasurementTests(unittest.TestCase):
    def test_ps_includes_descendants_only_and_preserves_commands_with_spaces(self):
        rows = parse_ps("10 1 100 /Applications/Our App\n11 10 200 helper\n12 11 300 nested\n13 1 400 unrelated\nmalformed\n")
        ids = descendants(rows, {10})
        self.assertEqual(ids, {10, 11, 12})
        self.assertEqual(sum(row.rss_kib for row in rows if row.pid in ids), 600)
        self.assertEqual(rows[0].command, "/Applications/Our App")
        with self.assertRaises(ValueError):
            parse_ps("wrong format")

    def test_linux_and_macos_swap_units(self):
        self.assertEqual(parse_linux_swap("SwapTotal: 8192 kB\nSwapFree: 3072 kB\n"), 5120)
        self.assertEqual(parse_mac_swap("total = 1024.00M used = 42.25M free = 981.75M"), 43264)
        self.assertEqual(parse_mac_swap("used = 2.00G"), 2 * 1024 * 1024)
        for parser in (parse_linux_swap, parse_mac_swap):
            with self.assertRaises(ValueError):
                parser("unavailable")

    def test_vm_and_gpu_fixtures(self):
        vm = parse_vm_stat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPageouts: 8.\nSwapins: 3.\nSwapouts: 4.\nPages occupied by compressor: 11.\n")
        self.assertEqual(vm, {"pageSizeBytes": 16384, "pageoutsPages": 8, "swapInsPages": 3, "swapOutsPages": 4, "compressorPages": 11})
        self.assertEqual(parse_nvidia("0, NVIDIA Test GPU, 512, 4096\n")[0]["usedMiB"], 512)
        with self.assertRaises(ValueError):
            parse_nvidia("unavailable")

    def test_missing_tools_are_missing_data_not_zero_memory(self):
        sampler = Sampler(include_ollama=True, nvidia=True)
        with patch("measure.subprocess.run", side_effect=FileNotFoundError), patch("measure.platform.system", return_value="Darwin"):
            result = sampler.sample(10)
        self.assertIsNone(result["processTreeRssKiB"])
        self.assertIsNone(result["systemSwapUsedKiB"])
        self.assertNotIn("nvidia", result)
        self.assertTrue(any("ps unavailable" in warning for warning in sampler.warnings))
        self.assertTrue(any("nvidia-smi unavailable" in warning for warning in sampler.warnings))

    def test_ollama_resources_are_separate_from_application_tree(self):
        sampler = Sampler(include_ollama=True)
        with patch.object(sampler, "tool", return_value="10 1 100 app\n11 10 20 appchild\n20 1 300 ollama\n21 20 400 modelrunner\n"), patch("measure.platform.system", return_value="Other"):
            sample = sampler.sample(10)
        self.assertEqual(sample["processTreeRssKiB"], 120)
        self.assertEqual(sample["ollamaRssKiB"], 700)

    def test_real_command_has_explicit_label_and_does_not_capture_output_or_arguments(self):
        report = measure([sys.executable, "-c", "print('private transcript phrase')"], interval=0.01, label="warm")
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["returnCode"], 0)
        self.assertEqual(report["runLabel"], "warm")
        self.assertNotIn("private transcript phrase", json.dumps(report))
        self.assertNotIn("-c", report)
        self.assertIn("not unique physical memory", report["scope"][0])

    def test_unspecified_labels_and_failed_launches_cannot_claim_acceptance(self):
        report = measure(["/nonexistent/local-benchmark-command"])
        self.assertEqual(report["status"], "launch-failed")
        self.assertEqual(report["runLabel"], "unspecified")
        self.assertIsNone(report["observations"]["peakProcessTreeRssKiB"])
        self.assertNotIn("/nonexistent", json.dumps(report))
        self.assertEqual(measure([sys.executable, "-c", "raise SystemExit(2)"])["status"], "command-failed")

    def test_cli_writes_a_report_and_preserves_failed_command_exit_status(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "report.json"
            completed = subprocess.run([sys.executable, str(Path(__file__).with_name("measure.py")), "--output", str(output), "--", sys.executable, "-c", "raise SystemExit(3)"], capture_output=True, text=True)
            self.assertEqual(completed.returncode, 3)
            report = json.loads(output.read_text())
            self.assertEqual(report["status"], "command-failed")
            self.assertEqual(report["returnCode"], 3)

    def test_invalid_sampling_arguments_do_not_launch(self):
        for interval in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                measure([sys.executable], interval=interval)

    @unittest.skipUnless(os.name == "posix", "Process groups require POSIX")
    def test_timeout_kills_the_launched_group_including_a_stubborn_descendant(self):
        with tempfile.TemporaryDirectory() as folder:
            pid_file = Path(folder) / "child.pid"
            child = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)"
            parent = "import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c',sys.argv[2]]); Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
            report = measure([sys.executable, "-c", parent, str(pid_file), child], interval=0.02, timeout=0.3)
            self.assertEqual(report["status"], "timed-out")
            self.assertTrue(pid_file.exists())
            self.assert_stopped(int(pid_file.read_text()))

    @unittest.skipUnless(os.name == "posix", "Process groups require POSIX")
    def test_cli_sigterm_writes_interrupted_report_and_stops_its_command(self):
        with tempfile.TemporaryDirectory() as folder:
            pid_file, report_file = Path(folder) / "command.pid", Path(folder) / "report.json"
            program = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)"
            wrapper = subprocess.Popen([sys.executable, str(Path(__file__).with_name("measure.py")), "--output", str(report_file), "--interval", "0.02", "--", sys.executable, "-c", program, str(pid_file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(pid_file.exists())
                wrapper.send_signal(signal.SIGTERM)
                self.assertEqual(wrapper.wait(timeout=5), 130)
                self.assertEqual(json.loads(report_file.read_text())["status"], "interrupted")
                self.assert_stopped(int(pid_file.read_text()))
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait()

    def assert_stopped(self, pid):
        # A terminated orphan can remain a zombie briefly under container PID 1.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                output = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, timeout=1).stdout.strip()
            except subprocess.SubprocessError:
                output = ""
            if not output or output.startswith("Z"):
                return
            time.sleep(0.02)
        self.fail(f"Launched process {pid} is still running")


if __name__ == "__main__":
    unittest.main()
