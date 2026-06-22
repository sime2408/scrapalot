"""
FastMCP Server for Scrapalot Chat API

This module provides MCP tools that expose the Scrapalot Chat API endpoints,
enabling LLM agents to interact with the system programmatically.

Architecture:
- mcp_api_client.py: Core HTTP client with session management
- mcp_endpoints.py: All API endpoint methods organized by resource
- scrapalot_mcp_server.py: MCP tool definitions (this file)

Features:
- Modern async/await patterns
- Comprehensive error handling
- Performance logging
- Ready for Postman collection export

Usage:
    python -m src.main.mcp.scrapalot_mcp_server
"""

import asyncio
from functools import wraps
import json
import time
import uuid

from fastmcp import FastMCP

from .mcp_api_client import DEFAULT_API_KEY
from .mcp_endpoints import ScrapalotEndpoints

# Initialize FastMCP server
mcp = FastMCP("Scrapalot Chat API")

# Logging setup
try:
    from src.main.utils.core.logger import get_logger

    logger = get_logger(__name__)
except ImportError:
    get_logger = None
    import logging

    logger = logging.getLogger(__name__)


# ==================== Decorators ====================


def log_mcp_performance(func):
    """Decorator to log MCP tool performance metrics"""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        start_time = time.time()
        tool_name = func.__name__

        try:
            result = await func(*args, **kwargs)
            duration = time.time() - start_time
            logger.info("[MCP_PERFORMANCE] %s completed in %.3fs", tool_name, duration)
            return result
        except Exception as e:
            duration = time.time() - start_time
            logger.error("[MCP_PERFORMANCE] %s failed after %.3fs: %s", tool_name, duration, str(e))
            raise

    return wrapper


def handle_mcp_errors(func):
    """Decorator to handle MCP tool errors consistently"""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except Exception as e:
            logger.debug("MCP tool %s error (this may be expected during startup): %s", func.__name__, str(e))
            return json.dumps({"status": "error", "message": str(e)}, indent=2)

    return wrapper


# ==================== Shared Auth Helper ====================

# Cached auth token to avoid re-authenticating on every tool call
_cached_auth_token: str | None = None


async def _auth_client(client: ScrapalotEndpoints) -> None:
    """Authenticate client using an API key (preferred) or username/password.

    Caches the JWT token so later tool calls skip the login round-trip.
    """
    global _cached_auth_token

    # API key path — no login needed, token set directly
    if DEFAULT_API_KEY:
        client.api_key = DEFAULT_API_KEY
        return

    # Reuse cached JWT token if available
    if _cached_auth_token:
        client.auth_token = _cached_auth_token
        return

    # Fall back to username/password login
    result = await _auth_client(client)
    # noinspection PyUnresolvedReferences
    _cached_auth_token = result.get("access_token")


# ==================== Authentication & User Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def authenticate_user(username: str, password: str) -> str:
    """
    Authenticate with the Scrapalot Chat API.

    Args:
        username: Username for authentication
        password: Password for authentication

    Returns:
        Authentication status and token information
    """
    async with ScrapalotEndpoints() as client:
        result = await client.authenticate(username, password)
        return json.dumps(
            {
                "status": "success",
                "message": "Authentication successful",
                "token_type": result.get("token_type", "bearer"),
                "expires_in": result.get("expires_in"),
            },
            indent=2,
        )


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def get_current_user() -> str:
    """Get current authenticated user information."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        user = await client.get_current_user()
        return json.dumps({"status": "success", "user": user}, indent=2)


# ==================== Workspace Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_workspaces(page: int = 1, page_size: int = 10) -> str:
    """
    Get list of workspaces for current user.

    Args:
        page: Page number for pagination
        page_size: Number of workspaces per page

    Returns:
        List of workspaces with metadata
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.list_workspaces(page=page, page_size=page_size)
        return json.dumps({"status": "success", "workspaces": result.get("workspaces", [])}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def get_default_workspace() -> str:
    """Get the default workspace for the current user."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        workspace = await client.get_default_workspace()
        return json.dumps({"status": "success", "workspace": workspace}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def create_workspace(name: str, description: str = None) -> str:
    """
    Create a new workspace.

    Args:
        name: Name of the workspace
        description: Optional description

    Returns:
        Created workspace details
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        workspace = await client.create_workspace(name, description)
        return json.dumps({"status": "success", "workspace": workspace}, indent=2)


# ==================== Collection Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_collections(workspace_id: str = None, page: int = 1, page_size: int = 50) -> str:
    """
    Get list of collections.

    Args:
        workspace_id: Optional workspace ID to filter by
        page: Page number for pagination
        page_size: Number of collections per page

    Returns:
        List of collections with metadata
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.list_collections(workspace_id=workspace_id, page=page, page_size=page_size)
        return json.dumps({"status": "success", "collections": result.get("collections", [])}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def create_collection(name: str, workspace_id: str, description: str = None) -> str:
    """
    Create a new collection in a workspace.

    Args:
        name: Name of the collection
        workspace_id: ID of the workspace
        description: Optional description

    Returns:
        Created collection details
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        collection = await client.create_collection(name, workspace_id, description)
        return json.dumps({"status": "success", "collection": collection}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def create_test_collection(name: str, description: str = "Test collection for MCP") -> str:
    """
    Create a new test collection in the default workspace.

    Args:
        name: Name of the collection
        description: Description of the collection

    Returns:
        Created collection details
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)

        # Get default workspace first
        workspace = await client.get_default_workspace()
        workspace_id = workspace["id"]

        # Create collection
        collection = await client.create_collection(name, workspace_id, description)
        return json.dumps({"status": "success", "collection": collection}, indent=2)


# ==================== Document Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def upload_document(file_path: str, collection_id: str) -> str:
    """
    Upload a document to a collection.

    Args:
        file_path: Path to the document file
        collection_id: ID of the collection

    Returns:
        Upload result with document ID
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.upload_document(file_path, collection_id)
        return json.dumps({"status": "success", "upload_result": result}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def upload_document_content(content: str, filename: str, collection_id: str) -> str:
    """
    Upload document content as a file.

    Args:
        content: Text content to upload
        filename: Filename to use
        collection_id: ID of the collection

    Returns:
        Upload result with document ID
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.upload_document_content(content, filename, collection_id)
        return json.dumps({"status": "success", "upload_result": result}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_documents(collection_id: str, page: int = 1, page_size: int = 50) -> str:
    """
    Get list of documents in a collection.

    Args:
        collection_id: ID of the collection
        page: Page number for pagination
        page_size: Number of documents per page

    Returns:
        List of documents with metadata
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.list_documents(collection_id, page=page, page_size=page_size)
        return json.dumps({"status": "success", "documents": result}, indent=2)


# ==================== Chat & Session Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def chat_with_documents(query: str, collection_id: str, rag_strategy: str = "balanced", model_name: str = None) -> str:
    """
    Send a chat message to query documents in a collection.

    Args:
        query: The question or message to send
        collection_id: ID of the collection to query
        rag_strategy: RAG strategy to use (balanced, precision, knowledge_intensive, etc.)
        model_name: Optional model name to use

    Returns:
        Chat response with retrieved documents and metadata
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.chat(query, collection_id=collection_id, model_name=model_name, rag_strategy=rag_strategy)
        return json.dumps(
            {"status": "success", "response": result.get("response", ""), "metadata": result.get("metadata", {})},
            indent=2,
        )


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def create_session(collection_id: str = None, conversation_name: str = None) -> str:
    """
    Create a new chat session.

    Args:
        collection_id: Optional collection ID to associate
        conversation_name: Optional name for the conversation

    Returns:
        Created session details
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        session = await client.create_session(collection_id, conversation_name)
        return json.dumps({"status": "success", "session": session}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_sessions(page: int = 1, page_size: int = 20) -> str:
    """
    Get list of chat sessions.

    Args:
        page: Page number for pagination
        page_size: Number of sessions per page

    Returns:
        List of sessions with metadata
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.list_sessions(page=page, page_size=page_size)
        return json.dumps({"status": "success", "sessions": result}, indent=2)


# ==================== Job Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_active_jobs(include_details: bool = True) -> str:
    """
    Get list of active jobs.

    Args:
        include_details: Whether to include job details

    Returns:
        List of active jobs with status
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        jobs = await client.list_active_jobs(include_details=include_details)
        return json.dumps({"status": "success", "jobs": jobs}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def get_job_status(job_id: str) -> str:
    """
    Get status of a specific job.

    Args:
        job_id: ID of the job

    Returns:
        Job status and details
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        job = await client.get_job_status(job_id)
        return json.dumps({"status": "success", "job": job}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def cancel_job(job_id: str) -> str:
    """
    Cancel an active job.

    Args:
        job_id: ID of the job to cancel

    Returns:
        Cancellation result
    """
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        result = await client.cancel_job(job_id)
        return json.dumps({"status": "success", "result": result}, indent=2)


# ==================== Settings & Provider Tools ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_providers() -> str:
    """Get list of LLM providers."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        providers = await client.list_providers()
        return json.dumps({"status": "success", "providers": providers}, indent=2)


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
async def list_models() -> str:
    """Get list of available LLM models."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        models = await client.list_models()
        return json.dumps({"status": "success", "models": models}, indent=2)


# ==================== End-to-End Test Tool ====================


@mcp.tool()
@log_mcp_performance
@handle_mcp_errors
# noinspection PyUnresolvedReferences
async def run_end_to_end_test(test_name: str = "mcp_test") -> str:
    """
    Run a complete end-to-end test of the RAG pipeline.

    Args:
        test_name: Name for the test collection

    Returns:
        Comprehensive test results including all pipeline stages
    """
    test_results = {"test_name": test_name, "stages": {}, "status": "running"}

    async with ScrapalotEndpoints() as client:
        # Stage 1: Authentication
        # noinspection PyUnresolvedReferences
        test_results["stages"]["authentication"] = {"status": "running"}
        await _auth_client(client)
        # noinspection PyUnresolvedReferences
        test_results["stages"]["authentication"] = {"status": "success"}

        # Stage 2: Get default workspace and create collection
        # noinspection PyUnresolvedReferences
        test_results["stages"]["collection_creation"] = {"status": "running"}
        workspace = await client.get_default_workspace()
        workspace_id = workspace["id"]

        collection_name = f"{test_name}_{uuid.uuid4().hex[:8]}"
        collection = await client.create_collection(collection_name, workspace_id)
        collection_id = collection["id"]
        # noinspection PyUnresolvedReferences
        test_results["stages"]["collection_creation"] = {"status": "success", "collection_id": collection_id}

        # Stage 3: Upload test document
        # noinspection PyUnresolvedReferences
        test_results["stages"]["document_upload"] = {"status": "running"}
        test_document = """
        # Cognitive Psychology: Understanding Mental Processes

        Cognitive psychology is the scientific study of mental processes such as attention, language use, memory, perception,
        problem solving, creativity, and reasoning.

        ## Core Areas of Study

        1. **Attention**: How we focus on specific stimuli while filtering out others
        2. **Memory**: The processes of encoding, storing, and retrieving information
        3. **Perception**: How we interpret and organize sensory information
        4. **Language Processing**: Understanding how we comprehend and produce language
        5. **Problem Solving**: The mental processes involved in finding solutions

        ## Key Principles

        - **Information Processing**: The mind works like a computer, processing information through stages
        - **Cognitive Load**: There are limits to how much information we can process simultaneously
        - **Schema Theory**: We organize knowledge into mental frameworks that guide understanding
        - **Metacognition**: Awareness and understanding of one's own thought processes

        ## Applications

        Cognitive psychology insights are applied in:
        - Educational psychology and learning strategies
        - Human-computer interaction design
        - Therapeutic interventions for cognitive disorders
        - Memory improvement techniques
        - Decision-making research
        """

        upload_result = await client.upload_document_content(test_document, "cognitive_psychology.md", collection_id)
        # noinspection PyUnresolvedReferences
        test_results["stages"]["document_upload"] = {
            "status": "success",
            "document_id": upload_result.get("document_id"),
        }

        # Stage 4: Wait for processing
        await asyncio.sleep(5)

        # Stage 5: Test RAG with different strategies
        test_questions = [
            "What is cognitive psychology?",
            "How does attention work in cognitive psychology?",
            "What are the main memory processes studied in cognitive psychology?",
        ]

        rag_strategies = ["balanced", "precision"]
        # noinspection PyUnresolvedReferences
        test_results["stages"]["rag_testing"] = {"status": "running", "results": {}}

        for strategy in rag_strategies:
            strategy_results = []
            for question in test_questions:
                chat_result = await client.chat(question, collection_id=collection_id, rag_strategy=strategy)
                strategy_results.append(
                    {
                        "question": question,
                        "response": (
                            chat_result.get("response", "")[:200] + "..."
                            if len(chat_result.get("response", "")) > 200
                            else chat_result.get("response", "")
                        ),
                        "metadata": chat_result.get("metadata", {}),
                    }
                )

            # noinspection PyTypeChecker,PyUnresolvedReferences
            test_results["stages"]["rag_testing"]["results"][strategy] = strategy_results

        # noinspection PyUnresolvedReferences
        test_results["stages"]["rag_testing"]["status"] = "success"

        # Stage 6: Final verification
        # noinspection PyUnresolvedReferences
        test_results["stages"]["final_verification"] = {"status": "running"}
        documents = await client.list_documents(collection_id)
        # noinspection PyUnresolvedReferences
        test_results["stages"]["final_verification"] = {"status": "success", "document_count": len(documents)}

        test_results["status"] = "completed"

    return json.dumps(test_results, indent=2)


# ==================== MCP Resources ====================


@mcp.resource("scrapalot://workspaces")
@handle_mcp_errors
async def resource_workspaces() -> str:
    """List all workspaces the authenticated user has access to."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        workspaces = await client.list_workspaces()
        return json.dumps(workspaces, indent=2)


@mcp.resource("scrapalot://collections")
@handle_mcp_errors
async def resource_collections() -> str:
    """List all document collections across all workspaces."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        workspaces = await client.list_workspaces()
        all_collections = []
        for ws in workspaces if isinstance(workspaces, list) else workspaces.get("workspaces", []):
            ws_id = ws.get("id", "")
            collections = await client.list_collections(ws_id)
            for col in collections if isinstance(collections, list) else []:
                col["workspace_id"] = ws_id
                col["workspace_name"] = ws.get("name", "")
                all_collections.append(col)
        return json.dumps(all_collections, indent=2)


@mcp.resource("scrapalot://providers")
@handle_mcp_errors
async def resource_providers() -> str:
    """List available LLM providers and their models."""
    async with ScrapalotEndpoints() as client:
        await _auth_client(client)
        providers = await client.list_providers()
        return json.dumps(providers, indent=2)


# ==================== MCP Prompts ====================


@mcp.prompt()
def prompt_rag_query(question: str, collection_name: str = "") -> str:
    """Generate a well-structured RAG query for document search."""
    collection_hint = f" in the '{collection_name}' collection" if collection_name else ""
    return (
        f"Search the knowledge base{collection_hint} and answer: {question}\n\nProvide a comprehensive answer with citations to specific documents."
    )


@mcp.prompt()
def prompt_deep_research(topic: str, depth: str = "standard") -> str:
    """Generate a deep research request for multi-source investigation."""
    depth_map = {"light": (2, 1), "standard": (4, 2), "thorough": (6, 3)}
    breadth, d = depth_map.get(depth, (4, 2))
    return f"Conduct deep research on: {topic}\n\nUse breadth={breadth}, depth={d}. Synthesize findings from multiple sources with proper citations."


@mcp.prompt()
def prompt_document_summary(document_name: str) -> str:
    """Generate a document summarization request."""
    return f"Summarize the document '{document_name}'. Include key findings, main arguments, and notable data points."


# ==================== Main Entry Point ====================

if __name__ == "__main__":
    mcp.run()
