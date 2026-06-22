# =============================================================================
# MULTI-STAGE DOCKERFILE
#
# Build target:
#   docker build --target app -t scrapalot-chat:latest .
# =============================================================================

# Enable BuildKit for cache mounts
# syntax=docker/dockerfile:1.4

# -----------------------------------------------------------------------------
# Stage 1: Base System Layer
# -----------------------------------------------------------------------------
FROM python:3.12.8-slim AS base-system

# Install minimal system dependencies
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    curl \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip setuptools wheel

ENV PIP_PREFER_BINARY=1
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# -----------------------------------------------------------------------------
# Stage 2: Full Dependencies
# -----------------------------------------------------------------------------
FROM base-system AS full-deps

# Install full build dependencies
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    cmake \
    pkg-config \
    sqlite3 \
    git \
    wget \
    libvulkan-dev \
    vulkan-tools \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt requirements-gpu.txt /tmp/

# Process requirements files
RUN grep -v "surya-ocr" /tmp/requirements.txt | \
    grep -v "marker-pdf" | \
    grep -v "^#" | \
    grep -v "^$" > /tmp/requirements_filtered.txt

# Install core dependencies
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install \
    psycopg2-binary==2.9.9 \
    asyncpg==0.30.0 \
    fastapi==0.116.1 \
    "uvicorn[standard]>=0.32.0,<1.0.0" \
    "websockets>=15.0,<16.0" \
    sqlalchemy==2.0.44 \
    pydantic[email]==2.11.9

# Install scientific packages
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install \
    "numpy>=1.26.0,<3.0" \
    "pandas>=2.2.0,<3.0" \
    "scikit-learn>=1.5.0,<2.0" \
    "scipy>=1.13.0,<2.0"

# Install PyTorch. TORCH_VARIANT=gpu builds the CUDA (cu128) wheels that
# support Blackwell sm_120 (matches requirements-gpu.txt); default `cpu` keeps
# the lightweight CPU build for the CPU-only prod box and CI. Pass via
# `--build-arg TORCH_VARIANT=gpu` when deploying to a GPU server.
ARG TORCH_VARIANT=cpu
RUN --mount=type=cache,target=/root/.cache/pip \
    if [ "$TORCH_VARIANT" = "gpu" ]; then \
        pip install --index-url https://download.pytorch.org/whl/cu128 \
            torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0 ; \
    else \
        pip install --index-url https://download.pytorch.org/whl/cpu \
            torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 ; \
    fi

# Install llama-cpp-python
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install llama-cpp-python==0.3.2 --no-cache-dir

# Install remaining dependencies
RUN --mount=type=cache,target=/root/.cache/pip \
    grep -v neo4j /tmp/requirements_filtered.txt | \
    grep -v "torch==" | grep -v "torchvision==" | grep -v "torchaudio==" | \
    grep -v "llama-cpp-python" | \
    grep -v "^--" | grep -v "^#" | grep -v "^$" | \
    sed '/^$/d' | sed 's/#.*//' | sed '/^[[:space:]]*$/d' > /tmp/requirements_final.txt && \
    pip install -r /tmp/requirements_final.txt

# Patch pymupdf4llm-layout: add null check for PDFs without StructTreeRoot
# Bug: parse_document() crashes with FzErrorArgument on PDFs with null catalog root
# Upstream: pymupdf4llm 1.27.2.1 — remove this patch when fixed in a future release
RUN LAYOUT_FILE=$(python -c "import pymupdf4llm.helpers.document_layout as m; print(m.__file__)") && \
    sed -i 's/        root\.pdf_dict_del(pymupdf\.PDF_NAME("StructTreeRoot"))/        if root.m_internal:\n            root.pdf_dict_del(pymupdf.PDF_NAME("StructTreeRoot"))/' "$LAYOUT_FILE" && \
    echo "Patched pymupdf4llm-layout StructTreeRoot null check"

# Install neo4j packages (installed separately because requirements.txt is
# filtered with `grep -v neo4j` above). With deps now: langchain-neo4j 0.10
# supports langchain-core 1.x and pulls neo4j-graphrag, which resolves cleanly
# on numpy 2.x — the old 0.5.0 `--no-deps` workaround for the numpy conflict is
# no longer needed.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install \
    "neo4j==5.28.2" \
    "langchain-neo4j==0.10.0" && \
    pip install pytz

# Pre-download spaCy model
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install https://github.com/explosion/spacy-models/releases/download/en_core_web_md-3.8.0/en_core_web_md-3.8.0-py3-none-any.whl || \
    echo "SpaCy model download failed, will retry at runtime"

# -----------------------------------------------------------------------------
# Target: app (~5.5GB)
# -----------------------------------------------------------------------------
FROM full-deps AS app

# Install runtime Vulkan dependencies + pandoc + pango for paper generation (Phase 5)
# + supervisor (PRD prd_onyx_worker_stability.md Phase 3 — per-queue worker split)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    libvulkan1 \
    mesa-vulkan-drivers \
    pandoc \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libpangoft2-1.0-0 \
    libgdk-pixbuf2.0-0 \
    supervisor \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* || true

# Install weasyprint for PDF generation (Phase 5 paper pipeline) and
# pydub for the voice/synthesize silent-MP3 prepend (Edge-TTS clips
# their first 50-150 ms of audio when Chrome's AudioContext is still
# spinning up; we prepend a fixed silent MP3 segment so the silence
# is encoded into the byte stream itself, immune to client-side
# AudioContext priming). pydub uses ffmpeg under the hood, hence the
# system package above.
RUN pip install --no-cache-dir weasyprint>=62.0 pydub>=0.25.1

WORKDIR /app

# Non-root runtime user. UID 1000 + GID 1000 matches the existing
# /app/data chown layout and the volume seed performed by earlier
# layers. The supplementary `scrapalot-dev` group (GID 1002) lets the
# container read bind-mounted source/configs from the host where files
# are owned by root:scrapalot-dev with 2775/2664 perms.
RUN groupadd -g 1000 scrapalot && \
    groupadd -g 1002 scrapalot-dev && \
    useradd -u 1000 -g scrapalot -G scrapalot-dev -m -s /bin/bash scrapalot

# Create necessary directories
RUN mkdir -p /app/data /app/data/models /app/data/logs /app/data/cache && \
    chown -R 1000:1000 /app/data && \
    chmod -R 755 /app/data

# Copy application files
COPY --chown=1000:1000 src/ ./src/
COPY --chown=1000:1000 alembic/ ./alembic/
COPY --chown=1000:1000 configs/ ./configs/
COPY --chown=1000:1000 scripts/ ./scripts/
COPY --chown=1000:1000 run_service.py alembic.ini __init__.py ./

# Create data directories
RUN mkdir -p /app/data/db /app/data/upload /app/data/models /app/data/logs /app/data/cache && \
    chown -R 1000:1000 /app/data

# Environment variables
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV ENVIRONMENT=prod
ENV HF_HOME=/app/data/models/huggingface
ENV HUGGINGFACE_HUB_CACHE=/app/data/models/huggingface
ENV HF_HUB_DISABLE_SYMLINKS=1
ENV HF_HUB_DISABLE_TELEMETRY=1
ENV HF_HUB_OFFLINE=0
ENV TRANSFORMERS_OFFLINE=0
ENV UPLOAD_PATH=/app/data/upload
ENV LLM_MODELS_DIRECTORY=/app/data/models
ENV SCRAPALOT_CACHE_DIR=/app/data/cache

EXPOSE 8090

HEALTHCHECK --interval=60s --timeout=60s --start-period=600s --retries=5 \
    CMD python -c "from src.main.utils.gpu import get_all_gpus; print(f'GPUs: {len(get_all_gpus())}')" || exit 1

# Cache bust for deployments
ARG BUILD_DATE=unknown
RUN echo "Build date: $BUILD_DATE" > /app/build_info.txt && \
    chown 1000:1000 /app/build_info.txt

# Drop-root entrypoint. Reconciles bind-mounted /app/data ownership
# with the runtime uid (1000) before exec'ing the CMD as that uid via
# setpriv. Without this, pre-existing host-side files from an earlier
# root-only image surface as EACCES on first mkdir under /app/data/upload.
COPY docker-scrapalot/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# supervisord config for Phase 3 per-queue worker split. Used ONLY when
# the container is launched as `scrapalot-workers` (compose overrides CMD
# to invoke supervisord). The chat container uses the default CMD below.
# Ownership: uid scrapalot, group scrapalot-dev (gid 1002) so both
# `scrapalot` and `github-runner` users on the host can edit/inspect the
# bind-mounted-via-CI version (per workspace CLAUDE.md: prod files use
# scrapalot:scrapalot-dev with 775 perms).
COPY --chown=1000:1002 docker-scrapalot/supervisord.conf /app/supervisord.conf

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "run_service.py"]
