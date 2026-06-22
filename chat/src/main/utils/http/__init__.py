"""
HTTP utilities sub-package.

Outbound API fetchers, endpoint health probes, FastAPI error helpers, and
static-file mounting for the embedded React UI.

Modules:
    errors        - handle_http_error: consistent FastAPI HTTPException raises
    health        - check_endpoint_health, check_provider_health, check_multiple_providers
    fetchers      - fetch_ollama_models_api, fetch_ollama_version, fetch_vllm_models_api
    static_files  - setup_static_files, mount_static_files, create_ui_routes (FastAPI mounts)
"""
