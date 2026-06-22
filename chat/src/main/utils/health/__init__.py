"""FastAPI runtime health endpoints.

- ``endpoints`` - Liveness / readiness / utility endpoints attached to the
                   FastAPI app at startup.

For outbound provider/endpoint probes (Ollama, vLLM, OpenAI, ...) see
``src.main.utils.http.health`` instead.
"""
