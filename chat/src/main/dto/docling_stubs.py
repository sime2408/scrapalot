"""
Stub classes for Docling components when the library is not available.

These classes provide the same interface as the real Docling classes but with
minimal functionality, allowing the application to gracefully handle cases
where Docling is not installed.
"""

from typing import Any


class DocumentConverter:
    """Stub for docling.document_converter.DocumentConverter"""

    def __init__(self, *args, **kwargs):
        pass

    def convert(self, *args, **kwargs):
        raise ImportError("Docling not available")


class InputFormat:
    """Stub for docling.datamodel.base_models.InputFormat"""

    PDF = "pdf"
    DOCX = "docx"


class PdfPipelineOptions:
    """Stub for docling.datamodel.pipeline_options.PdfPipelineOptions"""

    def __init__(self, *args, **kwargs):
        pass


class PdfFormatOption:
    """Stub for PdfFormatOption"""

    def __init__(self, pipeline_options: Any | None = None, pipeline_cls: Any | None = None, backend: Any | None = None):
        self.pipeline_options = pipeline_options
        self.pipeline_cls = pipeline_cls
        self.backend = backend


class WordFormatOption:
    """Stub for WordFormatOption"""

    def __init__(self, pipeline_options: Any | None = None, backend: Any | None = None):
        self.pipeline_options = pipeline_options
        self.backend = backend


class AcceleratorDevice:
    """Stub for docling.datamodel.accelerator_options.AcceleratorDevice"""

    # Enum-like attributes for device types
    CUDA = "cuda"
    MPS = "mps"
    CPU = "cpu"
    AUTO = "auto"


class AcceleratorOptions:
    """Stub for docling.datamodel.accelerator_options.AcceleratorOptions"""

    def __init__(self, num_threads: int = 8, device: Any = None):
        self.num_threads = num_threads
        self.device = device or AcceleratorDevice.CPU


class PyPdfiumDocumentBackend:
    """Stub for docling.backend.pypdfium2_backend.PyPdfiumDocumentBackend"""


class DoclingParseDocumentBackend:
    """Stub for docling.backend.docling_parse_backend.DoclingParseDocumentBackend"""


class StandardPdfPipeline:
    """Stub for docling.pipeline.standard_pdf_pipeline.StandardPdfPipeline"""
