# Dataset Generator (`scripts/dataset_generator.py`)

Generates Q&A pairs from book collections (PDF/EPUB) using Claude Code headless mode. Output: JSONL.

## Commands

```bash
# Generate dataset
python scripts/dataset_generator.py --input "E:/_KNJIGE/ufo" --output "datasets/ufo.jsonl" --state-db "datasets/ufo_state.db"

# Resume interrupted run (never use --no-resume unless starting completely fresh)
python scripts/dataset_generator.py --input "E:/_KNJIGE/ufo" --output "datasets/ufo.jsonl" --state-db "datasets/ufo_state.db" --resume

# Check progress (while pipeline is running)
conda run -n scrapalot-chat python scripts/dataset_generator/check_progress.py

# Remove duplicate book files before generating
conda run -n scrapalot-chat python scripts/dataset_generator/delete_duplicates.py "E:/_KNJIGE/ufo"
```

## Workflow for Cleaning Duplicates

When duplicate book files are found (same title as PDF + EPUB, or `(1)` copies):
1. **Stop** the pipeline
2. **Delete** duplicate files: `python scripts/dataset_generator/delete_duplicates.py <folder>`
3. **Resume** with `--resume` — do NOT use `--no-resume`, which discards already-processed books and their checkpoints

## Key Gotchas

- **Never delete state DB or JSONL when fixing duplicates** — use `--resume` to continue from where processing stopped
- **Per-chapter checkpointing**: each chapter is saved to `state.db` immediately; if pipeline crashes mid-book, it resumes from the next unprocessed chapter
- **Cross-book dedup**: runs automatically at the end of a full pipeline run (`deduplicate_jsonl()`)
- **Timeout** (`ClaudeTimeoutError`): books that time out are marked `failed` (retryable with `--resume`), not `skipped`
- **`skipped`** = intentionally excluded (empty text, no chapters); **`failed`** = error, will be retried on next `--resume` run
