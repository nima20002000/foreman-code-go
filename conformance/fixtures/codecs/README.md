# Fixed codec inputs

These are committed input bytes for the public conformance scenarios. No fixture
is a recorded server response, schema dump, test result or runtime output.

`sample.png`, `oriented.jpg`, `animated.gif` and `animated.webp` are copied from
`apps/api/src/modules/files/images/fixtures` at repository baseline
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`. The PNG is 8 × 6; the JPEG displays as
6 × 8 after EXIF rotation; the GIF and WebP have two 8 × 6 frames. Conformance
checks resizing through actual native file tool calls and public downloads.

`original.pdf` and `original.docx` contain one plain, fixed text section each.
`generate-documents.py` documents their deterministic construction using only
Python's standard library. The DOCX includes style and custom-property parts
that a document edit must preserve.

The input checksums in `manifest.json` identify these exact committed files.
Fixture generation does not qualify the application or count as a TS/Go test
pass. All conformance execution belongs to Foreman CI.

## CI readers

The independent output readers require the baseline-pinned `sharp` and `unpdf`
dependencies and `python3` with its standard `zipfile` and `xml.etree` modules.
No Office installation, external PDF worker or additional Python package is used.
`read-docx.py` reads a fresh scenario-owned download without extracting files. It
bounds the archive, every expanded part, entry count, XML depth and reader output;
the scenario compares all package parts and the entire parsed Word document.

Image checks decode every frame and compare every RGBA pixel after the fixed
display rotation and resize. RGB comparisons allow a maximum channel difference
of 64 at the fixtures' red/blue boundary for resampling and lossy JPEG/WebP
encoding. Dimensions, frame counts, alpha, animation delays and loop values have
exact assertions. Original attachment bytes remain an exact checksum match.
