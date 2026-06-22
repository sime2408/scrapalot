"""
ML model artefact utilities sub-package.

Local caching and on-demand downloading for HuggingFace embeddings and
spaCy NLP models. Both are pure file-system / network helpers; the
heavyweight ``model_downloader`` (which configures the project-level
``data/models/`` tree and bootstraps Docling + spaCy at startup) still
lives at ``src.main.utils.models.downloader`` to keep its relative-path
walking stable.

Modules:
    huggingface  - HuggingFaceDownloader: on-demand HF snapshot downloads
                   into the project's ``models/embeddings/huggingface/`` tree
    spacy_cache  - SpacyCache singleton — keeps spaCy NLP objects in memory
                   across calls so entity extraction doesn't re-load 100MB
                   of weights on every invocation
"""
