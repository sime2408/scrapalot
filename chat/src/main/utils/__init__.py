"""
Project-wide utility package.

All modules live inside thematic subpackages — there are no flat
``*_utils.py`` files at the root any more. Always import from the
canonical subpackage path below.

Subpackages:

    auth        - JWT validation/minting, API keys, session helpers
    config      - YAML config loader, default settings, desktop-mode toggle
    connectors  - External connector helpers + academic API contact emails
    core        - Foundational cross-cutting: logger, DI decorators,
                  error-code mapping
    database    - SQL session managers, DAO base, SQLModel helpers
    documents   - Document parsing, lifecycle, hierarchy helpers
    files       - Path normalisation + file-text extraction
    gpu         - Device detection / PyTorch / CUDA / MPS / CPU helpers
    graph       - Neo4j knowledge-graph service helpers
    health      - FastAPI runtime health / readiness endpoints
    http        - FastAPI error helpers, endpoint health probes,
                  outbound API fetchers, static-file mounting, security
    jobs        - Background dispatcher, active-job registry, progress
                  publishing, lifecycle cleanup
    llm         - Provider/model resolution, agent configuration,
                  reasoning-aware streaming, unified usage tracking,
                  agent-chain utilities, conversation context
    models      - HuggingFace + spaCy model artefact caches, downloader
    nlp         - spaCy / langdetect / tokenisation utilities
    rag         - Strategy registries, routing, provider base classes
    redis       - Redis client / embedded-Redis adapter
    startup     - Initialization, monitors, diagnostics, asyncio cleanup
    text        - Title-case, truncation, HTML strip, markdown / Tiptap
    tokens      - Token counting + per-conversation budget tracking
    websocket   - WebSocket connection manager + STOMP frame helpers
    workspaces  - Workspace access + storage-quota enforcement
"""
