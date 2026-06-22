# Integration Testing Guide

This directory contains **TRUE integration tests** that test against real environments without mocking.

## Directory Structure

```
tests/
├── integration/          # Main integration tests
│   ├── chat/             # Chat controller tests
│   ├── documents/        # Document controller tests
│   ├── settings/         # Settings controller tests
│   └── setup_test_data.py # Test data setup script
├── service/              # Service-level tests
├── db/                   # Database tests
├── scripts/              # Utility scripts (NOT tests)
├── books/                # Test documents (art_of_war.pdf)
├── conftest.py           # Shared fixtures and configuration
├── pytest.ini            # Pytest configuration and markers
└── .test_*               # Persistent test data files
```

## Environment Configuration

Tests automatically configure themselves based on the `ENVIRONMENT` variable:

### Production (Default in Docker)
```bash
ENVIRONMENT=prod  # Uses pgvector container
```
- **API**: Uses `BACKEND_BASE_URL` from Docker environment
- **Database**: pgvector container (PostgreSQL with pgvector extension)
- **APIs**: Uses `FIRECRAWL_API_KEY`, `OPENAI_API_KEY` from environment

### Development
```bash
ENVIRONMENT=dev
```
- **API**: `http://localhost:8090/api/v1`
- **Database**: pgvector container on localhost:15432

## Quick Start

### Running Tests (Inside Docker Container)

```bash
# Run all integration tests
docker exec scrapalot-chat python -m pytest tests/integration/ -v

# Run specific test categories
docker exec scrapalot-chat python -m pytest -m "integration" tests/
docker exec scrapalot-chat python -m pytest -m "not slow" tests/
docker exec scrapalot-chat python -m pytest -m "chat" tests/

# Run specific test file
docker exec scrapalot-chat python -m pytest tests/integration/chat/test_chat_controller.py -v

# Run with coverage
docker exec scrapalot-chat python -m pytest --cov=src/main tests/
```

### Test Data Setup

Before running tests, ensure test data is prepared:

```bash
# Check test data status
docker exec scrapalot-chat python tests/integration/setup_test_data.py --status

# Set up test data (uploads art_of_war.pdf and creates test entities)
docker exec scrapalot-chat python tests/integration/setup_test_data.py
```

### Required Test Data Files

These files store persistent test entity IDs:

| File | Purpose |
|------|---------|
| `.test_api_key` | API key for authenticated requests |
| `.test_user_id` | Test user UUID |
| `.test_workspace_id` | Test workspace UUID |
| `.test_collection_id` | Test collection UUID |
| `.test_document_id` | Test document UUID (art_of_war.pdf) |

## Test Markers

```bash
# Run by marker
pytest -m "integration"      # Integration tests
pytest -m "slow"             # Long-running tests (>30s)
pytest -m "rag"              # RAG strategy tests
pytest -m "chat"             # Chat controller tests
pytest -m "deep_research"    # Deep research tests
pytest -m "agentic"          # Agentic RAG tests

# Exclude markers
pytest -m "not slow"         # Skip slow tests
pytest -m "integration and not deep_research"  # Integration without deep research
```

## Test Book: art_of_war.pdf

The file `tests/books/art_of_war.pdf` is the primary test document:

- **Purpose**: Document parsing, chunking, embedding, RAG testing
- **Processing**: Enhanced markdown chunking, context expansion
- **Required for**: Document tests, RAG tests, chat tests

## CRITICAL Requirements

### Complete Integration Testing
- **NO MOCKS**: Tests use real API endpoints and databases
- **NO SHORTCUTS**: Complete workflows from start to finish
- **DATABASE VERIFICATION**: Tests query actual tables to verify results
- **REAL DATA**: Tests create, process, and verify actual data

### Deep Research Testing
- **REAL WEB SEARCHES**: Uses actual Firecrawl and search APIs
- **LIVE CONTENT EXTRACTION**: Extracts actual web content
- **AUTHENTIC SOURCES**: Verifies real URLs and content quality

### Forbidden Patterns
- Mocking database operations or API responses
- Skipping authentication or database verification
- Using workarounds instead of fixing source code issues
- Simulating results instead of using real systems

## Example Integration Test

```python
import pytest

class TestDocumentProcessing:
    """Document processing integration tests."""

    @pytest.mark.integration
    def test_document_upload_and_retrieval(
        self, authenticated_session, api_base_url, test_collection
    ):
        """Test document upload and RAG retrieval."""
        # Upload document
        with open('tests/books/art_of_war.pdf', 'rb') as f:
            response = authenticated_session.post(
                f"{api_base_url}/documents/upload",
                files={'file': f},
                data={'collection_id': str(test_collection['id'])}
            )
        assert response.status_code == 201

        # Verify in database
        doc_id = response.json()['id']
        doc_response = authenticated_session.get(
            f"{api_base_url}/documents/{doc_id}"
        )
        assert doc_response.json()['status'] == 'completed'
```

## Fixtures Reference

Key fixtures from `conftest.py`:

| Fixture | Scope | Purpose |
|---------|-------|---------|
| `setup_test_environment` | session | Validates environment configuration |
| `authenticated_session` | session | Requests session with API key auth |
| `api_base_url` | session | Backend API URL |
| `test_workspace` | session | Test workspace entity |
| `test_collection` | session | Test collection entity |
| `test_data_ready` | session | Validates all test data exists |
| `firecrawl_api_key` | session | Firecrawl API key for deep research |
| `db_connection` | session | PostgreSQL database connection |
| `db_cursor` | function | Database cursor for queries |

## Troubleshooting

### Missing Test Data
```bash
# Regenerate test data files
docker exec scrapalot-chat python tests/integration/setup_test_data.py

# Verify data status
docker exec scrapalot-chat python tests/integration/setup_test_data.py --status
```

### Database Connection Issues
```bash
# Check database connectivity
docker exec scrapalot-chat python -c "from src.main.config.database import SessionLocal; db = SessionLocal(); print('Connected')"
```

### API Key Issues
```bash
# Create test API key
docker exec scrapalot-chat python tests/scripts/create_test_api_key.py
```
