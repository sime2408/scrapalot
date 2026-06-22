"""
Workspace utilities sub-package.

Access helpers (ownership / role lookups against the
``collection_workspace_map`` cache) and subscription-tier storage quotas.

In shared workspaces, files are stored under the OWNER's directory and
the OWNER's quota is enforced — not the uploading user's.

Modules:
    access - get_workspace_owner_for_collection, check_user_workspace_role,
             can_user_modify_collection / read_collection, validate_workspace_access,
             get_workspace_id_for_collection, get_user_accessible_collections
    quota  - check_storage_quota, check_memory_only_quota,
             get_user_storage_usage, get_user_storage_limit,
             get_workspace_storage_usage, STORAGE_LIMITS, MEMORY_ONLY_LIMITS
"""
