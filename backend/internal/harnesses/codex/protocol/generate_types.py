"""Convert the frozen, native-generated Codex schema into Go compile-time types.

This does not launch Codex, validate an installation, or issue qualification evidence.
Run source generation only with the two pinned inputs and Go 1.27.2 in CI.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


# The frozen Git blob ends at '}' without a trailing newline. Preserve its bytes.
SCHEMA_SHA256 = "d71ddf3bf5484f8de2799f7a4793c2e66808a9ec1a330e2307accb088ab5948a"
METHODS_SHA256 = "4eebdcaee1f4e3a7c9aad51e80825d1d74c5303cbeea51ec9e9fc8607b36add4"
REFERENCE = "8d2ea76c5028ef4458bf8cd64ef8624422e71d9f"
GO_VERSION = "go1.27.2"


def pinned(path, expected):
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Unexpected source bytes: {path}")
    return data


def formatted_source(source):
    environment = os.environ.copy()
    environment.update(GOENV="off", GOWORK="off", GOTOOLCHAIN="local", GOFLAGS="")
    # Resolve the selected compiler's own root, never a separately inherited one.
    environment.pop("GOROOT", None)
    toolchain = subprocess.run(
        ["go", "env", "-json", "GOVERSION", "GOROOT"],
        env=environment, stdout=subprocess.PIPE, text=True, timeout=10, check=True,
    )
    settings = json.loads(toolchain.stdout)
    if settings["GOVERSION"] != GO_VERSION:
        raise ValueError(f"Expected {GO_VERSION} for source formatting; found {settings['GOVERSION']}")
    executable = "gofmt.exe" if os.name == "nt" else "gofmt"
    formatter = Path(settings["GOROOT"]) / "bin" / executable
    result = subprocess.run(
        [str(formatter)], input=source.encode("utf-8"), env=environment,
        stdout=subprocess.PIPE, timeout=10, check=True,
    )
    return result.stdout


def identifier(value):
    parts = re.findall(r"[A-Za-z0-9]+", value)
    result = "".join(part[0].upper() + part[1:] for part in parts)
    if not result or result[0].isdigit():
        result = "Value" + result
    return re.sub(r"Id$", "ID", result)


class Generator:
    def __init__(self, bundle):
        self.definitions = {}
        for key, value in bundle["definitions"].items():
            if key == "v2":
                self.definitions.update({f"v2/{name}": schema for name, schema in value.items()})
            else:
                self.definitions[key] = value
        self.selected = set()
        self.pending = []

    def select(self, path):
        if path not in self.definitions:
            raise ValueError(f"Missing native schema {path}")
        if path not in self.selected:
            self.selected.add(path)
            self.pending.append(path)
        return identifier(path)

    @staticmethod
    def without_null(schema):
        if isinstance(schema, bool):
            return {}, False
        schema = dict(schema)
        value = schema.get("type")
        if isinstance(value, list) and "null" in value:
            kinds = [entry for entry in value if entry != "null"]
            schema["type"] = kinds[0] if len(kinds) == 1 else kinds
            return schema, True
        for key in ("anyOf", "oneOf"):
            choices = schema.get(key, [])
            other = [entry for entry in choices if entry.get("type") != "null"]
            if len(choices) == 2 and len(other) == 1:
                return other[0], True
        return schema, False

    def go_type(self, schema, nullable=True):
        schema, has_null = self.without_null(schema)
        result = self.non_null_type(schema)
        if nullable and has_null and not result.startswith(("*", "[]", "map[")) and result != "json.RawMessage":
            return "*" + result
        return result

    def non_null_type(self, schema):
        if "$ref" in schema:
            prefix = "#/definitions/"
            ref = schema["$ref"]
            if not ref.startswith(prefix):
                raise ValueError(f"Unsupported schema reference {ref}")
            path = ref[len(prefix):].replace("~1", "/").replace("~0", "~")
            name = self.select(path)
            target = self.definitions[path]
            if target.get("type") == "object" and target.get("properties"):
                return "*" + name
            return name
        if len(schema.get("allOf", [])) == 1:
            return self.go_type(schema["allOf"][0])
        if any(key in schema for key in ("anyOf", "oneOf", "allOf")):
            return "json.RawMessage"
        kind = schema.get("type")
        if kind == "object":
            if schema.get("properties"):
                return self.object_type(schema)
            extra = schema.get("additionalProperties", True)
            if extra is False:
                return "struct{}"
            value = self.go_type(extra) if isinstance(extra, dict) else "json.RawMessage"
            return f"map[string]{value}"
        if kind == "array":
            items = schema.get("items", {})
            return "[]" + (self.go_type(items) if isinstance(items, dict) else "json.RawMessage")
        if kind == "string":
            return "string"
        if kind == "boolean":
            return "bool"
        if kind == "integer":
            format_name = schema.get("format")
            return format_name if format_name in ("int32", "int64", "uint32", "uint64") else "int64"
        if kind == "number":
            return "float64"
        return "json.RawMessage"

    def object_type(self, schema):
        fields = []
        required = set(schema.get("required", []))
        names = set()
        for key, value in sorted(schema["properties"].items()):
            name = identifier(key)
            if name in names:
                raise ValueError(f"Go field collision {key}")
            names.add(name)
            if key in required:
                kind = self.go_type(value)
                tag = key
            else:
                kind = f"Optional[{self.go_type(value, nullable=False)}]"
                tag = key + ",omitzero"
            fields.append(f'\t{name}\t{kind}\t`json:"{tag}"`')
        return "struct {\n" + "\n".join(fields) + "\n}"

    def render(self, methods):
        for params, response in methods.values():
            self.select(params)
            self.select(response)
        for name in ("TurnStartedNotification", "TurnCompletedNotification", "ItemCompletedNotification", "ServerRequestResolvedNotification"):
            self.select("v2/" + name)
        declarations = {}
        while self.pending:
            path = self.pending.pop()
            kind = self.go_type(self.definitions[path])
            # Raw unions keep every native branch intact; the required protocol port validates them.
            operator = " = " if kind == "json.RawMessage" else " "
            declarations[path] = f"type {identifier(path)}{operator}{kind}\n"
        header = (
            "// Code generated by generate_types.py from native Codex 0.154.0 schema; DO NOT EDIT.\n"
            f"// Frozen reference: {REFERENCE}.\n"
            f"// Schema SHA-256: {SCHEMA_SHA256}.\n"
            "// Compile-time baseline only; runtime uses the qualified installation's validators.\n"
            "package protocol\n\nimport \"encoding/json\"\n\n"
        )
        return header + "\n".join(declarations[path] for path in sorted(declarations))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--method-source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    schema = json.loads(pinned(args.schema, SCHEMA_SHA256))
    source = pinned(args.method_source, METHODS_SHA256).decode()
    methods = {}
    expression = r"(?:'([^']+)'|(initialize)):\s*\['([^']+)',\s*'([^']+)'\]"
    for quoted, plain, params, response in re.findall(expression, source):
        methods[quoted or plain] = (params, response)
    if not methods:
        raise ValueError("Pinned native method source contained no methods")
    generator = Generator(schema)
    formatted = formatted_source(generator.render(methods))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(formatted)
    print(json.dumps({"methods": len(methods), "native_types": len(generator.selected), "output": str(output)}))


if __name__ == "__main__":
    main()
