"""
Shared connector utilities for common connector operations.
"""

from typing import Any

from src.main.connectors.models import ConnectorSource, Document, DocumentMetadata, TextSection


def create_academic_paper_document(
    abstract: str,
    source: ConnectorSource,
    connector_id: str,
    title: str,
    document_id: str | None = None,
    authors: list[str] | None = None,
    year: int | None = None,
    url: str | None = None,
    pdf_url: str | None = None,
    citations: int | None = None,
    venue: str | None = None,
    categories: list[str] | None = None,
    primary_category: str | None = None,
    published_date: str | None = None,
    updated_date: str | None = None,
    publication_types: list[str] | None = None,
    comment: str | None = None,
    journal_ref: str | None = None,
    doi: str | None = None,
    source_type: str = "academic_paper",
) -> Document:
    """
    Create a Document for an academic paper with standardized metadata.

    Args:
        abstract: Paper abstract/content
        source: ConnectorSource enum value
        connector_id: Connector identifier
        title: Paper title
        document_id: Optional document ID
        authors: List of author names
        year: Publication year
        url: Paper URL
        pdf_url: PDF download URL
        citations: Citation count
        venue: Publication venue
        categories: Paper categories/topics
        primary_category: Primary category
        published_date: Publication date (ISO format)
        updated_date: Last update date (ISO format)
        publication_types: Types of publication
        comment: Additional comments
        journal_ref: Journal reference
        doi: Digital Object Identifier
        source_type: Type of source (default: "academic_paper")

    Returns:
        Document with standardized metadata
    """
    metadata_dict: dict[str, Any] = {
        "connector_id": connector_id,
        "file_name": f"{title}.txt",
        "title": title,
        "source_type": source_type,
    }

    # Add optional fields only if provided
    if authors:
        metadata_dict["authors"] = authors
    if year is not None:
        metadata_dict["year"] = year
    if url:
        metadata_dict["url"] = url
    if pdf_url:
        metadata_dict["pdf_url"] = pdf_url
    if citations is not None:
        metadata_dict["citations"] = citations
    if venue:
        metadata_dict["venue"] = venue
    if categories:
        metadata_dict["categories"] = categories
    if primary_category:
        metadata_dict["primary_category"] = primary_category
    if published_date:
        metadata_dict["published_date"] = published_date
    if updated_date:
        metadata_dict["updated_date"] = updated_date
    if publication_types:
        metadata_dict["publication_types"] = publication_types
    if comment:
        metadata_dict["comment"] = comment
    if journal_ref:
        metadata_dict["journal_ref"] = journal_ref
    if doi:
        metadata_dict["doi"] = doi

    # noinspection PyTypeChecker
    return Document(
        id=document_id,
        sections=[TextSection(text=abstract)] if abstract else [],
        source=source,
        semantic_identifier=title,
        metadata=DocumentMetadata(**metadata_dict),
    )


def create_oauth_token_response(
    access_token: str,
    refresh_token: str | None = None,
    expires_in: int | None = None,
    token_type: str = "Bearer",
) -> dict[str, str]:
    """
    Create a standardized OAuth token response dictionary.

    Args:
        access_token: OAuth access token
        refresh_token: Optional refresh token
        expires_in: Optional token expiration time in seconds
        token_type: Token type (default: "Bearer")

    Returns:
        Dictionary with OAuth token information
    """
    response: dict[str, Any] = {
        "access_token": access_token,
        "refresh_token": refresh_token,
    }

    if expires_in is not None:
        response["expires_in"] = expires_in
    if token_type:
        response["token_type"] = token_type

    return response


def validate_connector_and_destination(db, connector_id: str, destination_id: str):
    """
    Validate that connector and sync destination exist in database.

    Args:
        db: Database session
        connector_id: Connector UUID string
        destination_id: Sync destination UUID string

    Returns:
        Tuple of (connector, destination) objects

    Raises:
        ValueError: If connector or destination not found
    """
    from uuid import UUID

    from src.main.models.sqlmodel_connectors import Connector, ConnectorSyncDestination

    # noinspection PyTypeChecker
    connector = db.query(Connector).filter(Connector.id == UUID(connector_id)).first()
    if not connector:
        raise ValueError(f"Connector not found: {connector_id}")

    # noinspection PyTypeChecker
    destination = db.query(ConnectorSyncDestination).filter(ConnectorSyncDestination.id == UUID(destination_id)).first()
    if not destination:
        raise ValueError(f"Sync destination not found: {destination_id}")

    return connector, destination
