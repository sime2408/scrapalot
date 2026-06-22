"""
Integration test for the workspace connector factory registry.

Guards against the regression where _register_all_connectors() had `pass`
blocks instead of real imports, leaving only Zotero registered at runtime
while the frontend advertised 7 active connectors.

Runs inside the scrapalot-chat container (uses the same Python process, no
HTTP round-trip). Does NOT exercise OAuth or sync — it only verifies that
each enum value advertised as "active" has a connector class registered in
the factory registry. Live OAuth/sync verification is a separate manual
exercise that needs real provider credentials.
"""

import sys

import pytest

from src.main.connectors.models import ConnectorSource

# Enum values that exist as placeholders but are not yet implemented.
# They are hidden or marked COMING_SOON on the frontend and should NOT have
# a registered connector class.
RESERVED_SOURCES = {
    ConnectorSource.FILE,
    ConnectorSource.WEB,
    ConnectorSource.YOUTUBE,
    ConnectorSource.MCP,
    ConnectorSource.ONENOTE,
}

# Connectors whose backing classes import optional third-party SDKs that
# may not be installed in every environment. Missing these is a soft
# failure — the factory logs a warning and skips them — so the test does
# not assert their presence.
OPTIONAL_SOURCES = {
    ConnectorSource.GOOGLE_DRIVE,  # needs google-api-python-client
}


@pytest.mark.integration
class TestConnectorFactoryRegistry:
    """Verifies that the factory registers every advertised connector."""

    @pytest.fixture(autouse=True)
    def _fresh_factory(self):
        """Force a clean import of the factory module for each test."""
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith("src.main.connectors"):
                sys.modules.pop(mod_name, None)
        yield

    def test_registry_contains_all_active_sources(self):
        """Every non-reserved, non-optional enum value must have a class registered."""
        from src.main.connectors.factory import _CONNECTOR_REGISTRY, list_available_connectors

        # list_available_connectors() triggers registration at module import.
        list_available_connectors()

        required_sources = set(ConnectorSource) - RESERVED_SOURCES - OPTIONAL_SOURCES
        registered_sources = set(_CONNECTOR_REGISTRY.keys())

        missing = required_sources - registered_sources
        assert not missing, (
            f"Connector enum values advertised as active but not registered in factory: "
            f"{sorted(s.value for s in missing)}. "
            f"Check _register_all_connectors() in src/main/connectors/factory.py — "
            f"the import block for each missing connector must actually import its module."
        )

    def test_registered_sources_are_valid_enum_values(self):
        """Every registered key must correspond to a ConnectorSource enum value.

        Catches decorator typos like @register_connector(ConnectorSource.NONEXISTENT).
        """
        from src.main.connectors.factory import _CONNECTOR_REGISTRY, list_available_connectors

        list_available_connectors()

        valid_values = set(ConnectorSource)
        registered = set(_CONNECTOR_REGISTRY.keys())

        invalid = registered - valid_values
        assert not invalid, f"Factory registered sources not in ConnectorSource enum: {invalid}"

    def test_list_available_returns_same_set_as_registry(self):
        """The public list_available_connectors() API must expose every registered class."""
        from src.main.connectors.factory import _CONNECTOR_REGISTRY, list_available_connectors

        listed = list_available_connectors()

        assert set(listed.keys()) == {s.value for s in _CONNECTOR_REGISTRY.keys()}
        for source, info in listed.items():
            assert "name" in info
            assert "class" in info
            assert "requires_oauth" in info
            assert "supports_auto_sync" in info
