"""Public CLI regressions; execute only through terminal-dispatched Foreman CI."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class GeneratorCLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="foreman-codex-generator-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        package = Path(__file__).resolve().parent
        repository = package.parents[4]
        self.generator = package / "generate_types.py"
        # These captured native inputs are unchanged at the pinned fork checkpoint.
        # The public generator itself must reject any bytes outside its frozen pin.
        self.schema = (repository / "apps/api/test/fixtures/codex-protocol.schemas.json").read_bytes()
        self.methods = (repository / "scripts/generate-codex-method-types.mjs").read_bytes()
        self.environment = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.root),
            "USERPROFILE": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "TMPDIR": str(self.root),
            "TMP": str(self.root),
            "TEMP": str(self.root),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "GOENV": "off",
            "GOWORK": "off",
            "GOTOOLCHAIN": "local",
        }

    def invoke(self, name, schema):
        directory = self.root / name
        directory.mkdir()
        schema_path = directory / "schema.json"
        methods_path = directory / "methods.mjs"
        output_path = directory / "types.gen.go"
        schema_path.write_bytes(schema)
        methods_path.write_bytes(self.methods)
        output_path.write_bytes(b"existing output must survive rejected input\n")
        result = subprocess.run(
            [sys.executable, str(self.generator), "--schema", str(schema_path),
             "--method-source", str(methods_path), "--output", str(output_path)],
            cwd=directory, env=self.environment, capture_output=True, text=True,
            timeout=10, check=False,
        )
        return result, output_path

    def test_frozen_native_inputs_generate_reproducibly(self):
        first, first_output = self.invoke("first", self.schema)
        self.assertEqual(first.returncode, 0, first.stderr)
        second, second_output = self.invoke("second", self.schema)
        self.assertEqual(second.returncode, 0, second.stderr)
        first_result = json.loads(first.stdout)
        second_result = json.loads(second.stdout)
        self.assertEqual(first_result["methods"], 16)
        self.assertEqual(first_result["native_types"], 112)
        self.assertEqual(first_result["output"], str(first_output))
        self.assertEqual(second_result["output"], str(second_output))
        self.assertEqual(first_result["methods"], second_result["methods"])
        self.assertEqual(first_result["native_types"], second_result["native_types"])
        self.assertNotEqual(first_output.read_bytes(), b"existing output must survive rejected input\n")
        self.assertEqual(first_output.read_bytes(), second_output.read_bytes())

    def test_generated_output_is_already_gofmt_formatted(self):
        result, output = self.invoke("formatted", self.schema)
        self.assertEqual(result.returncode, 0, result.stderr)
        toolchain = subprocess.run(
            ["go", "env", "-json", "GOVERSION", "GOROOT"],
            cwd=self.root, env=self.environment, capture_output=True, text=True,
            timeout=10, check=False,
        )
        self.assertEqual(toolchain.returncode, 0, toolchain.stderr)
        settings = json.loads(toolchain.stdout)
        self.assertEqual(settings["GOVERSION"], "go1.27.2")
        executable = "gofmt.exe" if os.name == "nt" else "gofmt"
        formatted = subprocess.run(
            [str(Path(settings["GOROOT"]) / "bin" / executable)],
            input=output.read_bytes(), cwd=self.root, env=self.environment,
            capture_output=True, timeout=10, check=False,
        )
        self.assertEqual(formatted.returncode, 0, formatted.stderr)
        self.assertEqual(output.read_bytes(), formatted.stdout)

    def test_missing_go_toolchain_preserves_existing_output(self):
        self.environment["PATH"] = str(self.root / "unavailable-tools")
        result, output = self.invoke("missing-toolchain", self.schema)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("go", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(output.read_bytes(), b"existing output must survive rejected input\n")

    def test_added_newline_is_rejected_without_touching_output(self):
        result, output = self.invoke("wrong-bytes", self.schema + b"\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unexpected source bytes:", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(output.read_bytes(), b"existing output must survive rejected input\n")


if __name__ == "__main__":
    unittest.main()
