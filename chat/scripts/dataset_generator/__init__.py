"""Book Knowledge Dataset Generator.

Extract Q&A pairs from non-fiction books using Claude Code headless mode.

Layout
------

```
core/      models, config, cli, state DB
extract/   scanner (pdf/epub discovery), text extractor, chapter assembler
generate/  Claude subprocess client (claude.py) + Q&A orchestrator (qa.py)
output/    JSONL writer + TF-IDF deduplication
targets/   pluggable upload destinations (REST API, direct PostgreSQL) + Protocol base
runtime/   per-book pipeline, parallel multi-process orchestrator, dry-run reporting
pipeline.py    public ``run_pipeline`` entry point used by ``scripts/dataset_generator.py``
```

Public symbols are exposed lazily via :pep:`562` so importing the top-level
package stays cheap (no PyTorch / requests / psycopg2 pulled in until the
caller actually touches one of them).

The standalone tools live at the package root:
  * ``check_progress.py`` is a sibling under ``scripts/``
  * ``delete_duplicates.py`` is a one-off filesystem cleanup utility
"""

from __future__ import annotations

# Map of public-symbol → (submodule, attribute). Resolved on first access.
_LAZY_EXPORTS: dict[str, tuple[str, str]] = {
    "BookInfo": ("core.models", "BookInfo"),
    "BookStatus": ("core.models", "BookStatus"),
    "ChapterData": ("core.models", "ChapterData"),
    "DatasetGeneratorConfig": ("core.config", "DatasetGeneratorConfig"),
    "DbWriteContext": ("targets.postgres", "DbWriteContext"),
    "FileType": ("core.models", "FileType"),
    "GenerationResult": ("core.models", "GenerationResult"),
    "QAMetadata": ("core.models", "QAMetadata"),
    "QAOutput": ("core.models", "QAOutput"),
    "QAPair": ("core.models", "QAPair"),
    "ScrapalotDbWriter": ("targets.postgres", "ScrapalotDbWriter"),
    "ScrapalotUploader": ("targets.rest", "ScrapalotUploader"),
    "UploadContext": ("targets.rest", "UploadContext"),
    "UploadTarget": ("targets.base", "UploadTarget"),
    "load_config": ("core.config", "load_config"),
    "parse_args": ("core.cli", "parse_args"),
    "run_pipeline": ("pipeline", "run_pipeline"),
}

__all__ = sorted(_LAZY_EXPORTS)


def __getattr__(name: str):
    """PEP 562 lazy attribute resolver — keeps ``import scripts.dataset_generator`` cheap."""
    if name in _LAZY_EXPORTS:
        module_suffix, attr = _LAZY_EXPORTS[name]
        from importlib import import_module

        module = import_module(f"{__name__}.{module_suffix}")
        value = getattr(module, attr)
        globals()[name] = value  # cache for subsequent attribute access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return [*globals().keys(), *__all__]
