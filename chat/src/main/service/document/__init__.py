"""
Document Service Module

This module provides document processing services including:
- Document upload and storage
- Text extraction and chunking
- Embedding generation and storage
- Integration with knowledge graph
"""
# noinspection PyUnresolvedReferences

__all__ = [
    "DocumentProcessingError",
    "DocumentService",
    "EPUBProcessor",
    "PDFProcessor",
    "document_job_manager",
    "document_processor",
    "epub_processor",
    "pdf_processor",
]

# All imports are deferred via __getattr__ to avoid triggering heavy
# initialization (database connection, WebSocketManager) when only a
# lightweight submodule (e.g. document_processor_pdf) is needed.
# Any `from src.main.service.document import X` still works transparently.


def __getattr__(name: str):
    if name == "document_job_manager":
        from src.main.service.document.document_job_manager import document_job_manager

        globals()["document_job_manager"] = document_job_manager
        return document_job_manager

    if name == "document_processor":
        from src.main.service.document.document_processor import document_processor

        globals()["document_processor"] = document_processor
        return document_processor

    if name in ("EPUBProcessor", "epub_processor"):
        from src.main.service.document.document_processor_epub import EPUBProcessor, epub_processor

        globals().update({"EPUBProcessor": EPUBProcessor, "epub_processor": epub_processor})
        return globals()[name]

    if name in ("PDFProcessor", "pdf_processor"):
        from src.main.service.document.document_processor_pdf import PDFProcessor, pdf_processor

        globals().update({"PDFProcessor": PDFProcessor, "pdf_processor": pdf_processor})
        return globals()[name]

    if name in ("DocumentService", "DocumentProcessingError"):
        from src.main.service.document.documents import DocumentProcessingError, DocumentService

        globals().update({"DocumentService": DocumentService, "DocumentProcessingError": DocumentProcessingError})
        return globals()[name]

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
