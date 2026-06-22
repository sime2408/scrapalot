"""
Redis utilities sub-package.

Groups Redis client access and the embedded-Redis compatibility adapter.
Candidate for extraction as a standalone pip package (scrapalot-redis-utils).

Modules:
    client  - get_redis_client(): singleton Redis / embedded-Redis factory
    adapter - RedisAdapter: LangChain-compatible wrapper around redislite/fakeredis
"""
