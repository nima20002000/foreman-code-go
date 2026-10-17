"""Bounded independent ZIP/XML oracle for downloaded conformance documents."""
import base64
import json
import sys
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree
from zipfile import ZipFile

MAX_BYTES = 1_048_576
MAX_ENTRIES = 32
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def xml_tree(element, depth=0):
    if depth > 32:
        raise ValueError("Document XML is deeper than the fixture bound")
    return {"tag": element.tag, "attributes": dict(sorted(element.attrib.items())),
            "text": element.text, "tail": element.tail,
            "children": [xml_tree(child, depth + 1) for child in element]}


def inspect_document(path):
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Downloaded DOCX exceeds the fixture byte bound")
    with ZipFile(path) as archive:
        entries = archive.infolist()
        if not 1 <= len(entries) <= MAX_ENTRIES:
            raise ValueError("DOCX entry count exceeds the fixture bound")
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("DOCX contains duplicate parts")
        if sum(entry.file_size for entry in entries) > MAX_BYTES:
            raise ValueError("Expanded DOCX exceeds the fixture byte bound")
        files = {}
        directories = []
        for entry in entries:
            parts = PurePosixPath(entry.filename).parts
            if not parts or entry.filename.startswith("/") or ".." in parts or "\\" in entry.filename:
                raise ValueError("DOCX contains an unexpected part name")
            if entry.flag_bits & 1 or entry.file_size > MAX_BYTES:
                raise ValueError("DOCX contains an encrypted or oversized part")
            data = archive.read(entry)
            if entry.is_dir():
                if data:
                    raise ValueError("DOCX directory contains bytes")
                directories.append(entry.filename)
                continue
            if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                raise ValueError("Fixture XML must not contain declarations")
            files[entry.filename] = data
        if any(not any(name.startswith(directory) for name in files) for directory in directories):
            raise ValueError("DOCX has a directory unrelated to its package parts")
        document = ElementTree.fromstring(files["word/document.xml"])
        if document.tag != f"{{{WORD}}}document":
            raise ValueError("DOCX main part is not a Word document")
        return {"parts": [{"name": name, "contentBase64": base64.b64encode(data).decode("ascii")}
                          for name, data in sorted(files.items())],
                "document": xml_tree(document)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("Expected one isolated downloaded document path")
    print(json.dumps(inspect_document(Path(sys.argv[1])), separators=(",", ":")))
