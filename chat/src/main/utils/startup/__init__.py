"""
Application lifecycle utilities sub-package.

Tracks initialization progress, records startup checkpoints / agent-call
performance, runs production environment diagnostics, and cleans up the
asyncio task graph on shutdown.

Modules:
    state            - StartupStateManager + InitializationStatus enum.
                       Tracks per-task init progress and answers
                       ``is_ready`` / ``is_healthy``.
    monitor          - StartupMonitor (startup-phase checkpoints + slow-step
                       summary) AND PerformanceMonitor (rolling stats for
                       agentic RAG agent calls).
    diagnostics      - System / network / cloud-environment probes used
                       to debug 502 errors and deployment issues.
    asyncio_cleanup  - AsyncioTaskManager + event-loop teardown helpers
                       that avoid GC exceptions on shutdown.
"""
