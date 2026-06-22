# spaCy Models Directory

This directory is used to store local spaCy models for entity extraction.

## Overview

When the entity extraction task runs, it will check for models in this directory **before** downloading from the internet. This is useful for:
- Offline deployments
- Faster startup (avoid re-downloading 400MB+ models)
- Version control of specific model versions
- Air-gapped environments

## Model Loading Priority

The system tries to load spaCy models in this order:
1. **Local path** (this directory): `data/models/spacy/{model_name}/`
2. **Installed packages**: Python site-packages (installed via `python -m spacy download`)
3. **Auto-download**: Downloads from spaCy's CDN if not found

## Supported Models

- `en_core_web_sm` - Small English model (~12 MB)
- `en_core_web_md` - Medium English model (~40 MB)
- `en_core_web_lg` - Large English model (~400 MB) - **Default**
- `en_core_web_trf` - Transformer-based model (~500 MB)

See [spaCy Models](https://spacy.io/models/en) for the full list.

## How to Add a Model Locally

### Option 1: Download from spaCy (Recommended)

```bash
# Download the model
python -m spacy download en_core_web_lg

# Find where it was installed
python -c "import spacy; print(spacy.util.get_package_path('en_core_web_lg'))"

# Copy to local directory
cp -r <path-from-above> data/models/spacy/en_core_web_lg
```

### Option 2: Manual Download

```bash
# Download from GitHub releases
wget https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl

# Extract the wheel (it's a zip file)
unzip en_core_web_lg-3.8.0-py3-none-any.whl -d en_core_web_lg

# Move to local directory
mv en_core_web_lg/en_core_web_lg data/models/spacy/
```

### Option 3: Use Existing Installation

If you already have the model installed via pip, you can create a symlink:

```bash
# Linux/Mac
ln -s $(python -c "import spacy; print(spacy.util.get_package_path('en_core_web_lg'))") data/models/spacy/en_core_web_lg

# Windows (as Administrator)
mklink /D data\models\spacy\en_core_web_lg "C:\path\to\installed\model"
```

## Configuration

Set the model path in `configs/config.yaml`:

```yaml
entity_extraction:
  spacy_model: en_core_web_lg
  spacy_model_path: data/models/spacy  # Default location
```

Or via environment variable:

```bash
export ENTITY_EXTRACTION_SPACY_MODEL=en_core_web_lg
export ENTITY_EXTRACTION_SPACY_PATH=data/models/spacy
```

## Directory Structure

```
data/models/spacy/
├── README.md (this file)
├── en_core_web_lg/          # Large model (400 MB)
│   ├── meta.json
│   ├── config.cfg
│   ├── vocab/
│   ├── ner/
│   └── ...
├── en_core_web_md/          # Medium model (40 MB)
│   └── ...
└── en_core_web_sm/          # Small model (12 MB)
    └── ...
```

## Verification

To verify a local model works:

```bash
cd scrapalot-chat
python -c "import spacy; nlp = spacy.load('data/models/spacy/en_core_web_lg'); print('Success!')"
```

## Troubleshooting

**Model not loading from local path:**
- Verify the directory structure matches the model name
- Check that `meta.json` and `config.cfg` exist in the model directory
- Ensure file permissions are readable

**Model version mismatch:**
- spaCy models are version-specific (e.g., 3.8.0 for spaCy 3.8.x)
- Check your spaCy version: `python -c "import spacy; print(spacy.__version__)"`
- Download the matching model version

**Still downloading despite local model:**
- Check logs for "Found local spaCy model at: ..." message
- Verify config setting: `spacy_model_path` in `config.yaml`
- Model directory must be named exactly as the model (e.g., `en_core_web_lg`)

## See Also

- [spaCy Models Documentation](https://spacy.io/models)
- [Entity Extraction Configuration](../../../configs/config.yaml)
- [Entity Extraction Service](../../../src/main/service/graph/entity_extraction/)
