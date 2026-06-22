"""
Authentication utilities sub-package.

Note that authentication itself (login, password verification) lives in
the Kotlin backend. The Python side only *validates* incoming JWTs and
issues new ones for the desktop variant, plus handles internal API key
authentication and lightweight session helpers.

Modules:
    jwt       - User Pydantic model, JWT validate/create, ALGORITHM /
                SECRET_KEY constants, ACCESS_TOKEN_EXPIRE_MINUTES /
                REFRESH_TOKEN_EXPIRE_DAYS
    api_keys  - generate_api_key, hash_api_key, verify_api_key (``scp-`` prefix)
    sessions  - parse_composite_session_id, split_composite_session_id,
                get_user_session, get_user_session_or_404
"""
