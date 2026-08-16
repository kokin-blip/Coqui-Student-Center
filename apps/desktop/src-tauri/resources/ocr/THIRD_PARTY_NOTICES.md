# OCR third-party notice policy

The release runtime is reconstructed from `runtime-sources.json`; native binaries are not committed to the repository.

- PDF rendering uses PDFium rather than Poppler to avoid introducing GPL code into Student Center. The pinned PDFium archive includes its license and notices for every compiled third-party component.
- Tesseract OCR 5.5.2, `tessdata_fast` 4.1.0, and the exact official TSV output config are Apache-2.0. Their release tags or commits are pinned and recorded separately.
- Tesseract is built with static native dependencies from a pinned vcpkg baseline. Preparation copies every installed package's `share/<port>/copyright` file.
- Each target runtime includes `THIRD_PARTY_NOTICES.txt`, a `licenses/` tree, and `runtime-lock.json`. The strict release gate hashes all of them.

This policy file is not itself the distributable notice. The target-specific generated notice tree is authoritative for an installer.
