"""
File-system utilities sub-package.

Path normalisation for the dual ``data/upload/`` + ``data/content/``
storage tree, plus text extraction for common document formats.

Modules:
    paths      - normalize_upload_path_to_url, normalize_path_for_db,
                 extract_relative_upload_path
    extraction - extract_file_text (PDF / DOCX / TXT / fallback)
"""
