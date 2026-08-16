# OCR runtime layout

Tauri copies this directory to `$RESOURCE/ocr`. Release preparation places platform-specific runtime files under one of these directories:

```text
windows-x64/lib/pdfium.dll
windows-x64/bin/tesseract.exe
windows-x64/tessdata/eng.traineddata
windows-x64/tessdata/configs/tsv
windows-x64/runtime-lock.json
macos-arm64/lib/libpdfium.dylib
macos-arm64/bin/tesseract
macos-arm64/tessdata/eng.traineddata
macos-arm64/tessdata/configs/tsv
macos-arm64/runtime-lock.json
```

Student Center loads PDFium only inside an isolated helper invocation of its own desktop executable, then writes bounded compressed PNG page images for Tesseract. The helper loads PDF bytes from memory for Unicode-safe paths and enforces a 512 MiB aggregate output ceiling. The parent app terminates a renderer or OCR process that exceeds its deadline. Startup probes must load PDFium and Tesseract must report the English model before the UI claims OCR is ready. Development overrides are `STUDENT_CENTER_PDFIUM`, `STUDENT_CENTER_TESSERACT`, and `STUDENT_CENTER_TESSDATA`.

`runtime-sources.json` pins the signed Tesseract and trained-data tags, the vcpkg baseline, and immutable PDFium assets and hashes. `npm run ocr:prepare -- --target=<target> --tesseract-root=<vcpkg-triplet-root>` downloads and verifies PDFium/trained-data, stages the source-built Tesseract executable, collects every vcpkg/PDFium notice, probes English OCR, and emits a per-build `runtime-lock.json`. `npm run ocr:verify -- --target=<target> --require-ready` rejects missing, tampered, or source-manifest-mismatched files.

Generated platform directories are ignored by Git. CI reconstructs them from pinned sources immediately before the Tauri build, so the installer contains the verified runtime without storing native executables in the repository.
