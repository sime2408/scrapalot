package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.common.Empty
import com.scrapalot.backend.grpc.common.StatusResponse
import com.scrapalot.backend.grpc.external_books.*
import io.grpc.Deadline
import mu.KotlinLogging
import org.springframework.stereotype.Service
import java.util.concurrent.TimeUnit

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python ExternalBooksService.
 *
 * External book search, download, preview, and processing operations.
 */
@Service
class ExternalBooksGrpcClient(
    private val stub: ExternalBooksServiceGrpcKt.ExternalBooksServiceCoroutineStub
) {
    suspend fun getSources(): SourcesResponse {
        logger.info { "gRPC GetSources" }
        return stub.getSources(Empty.getDefaultInstance())
    }

    suspend fun searchBooks(request: SearchBooksRequest): SearchBooksResponse {
        logger.info { "gRPC SearchBooks: query=${request.query}" }
        return stub
            .withDeadline(Deadline.after(60, TimeUnit.SECONDS))
            .searchBooks(request)
    }

    suspend fun downloadAndProcess(request: DownloadProcessRequest): DownloadResponse {
        logger.info { "gRPC DownloadAndProcess: title=${request.title}" }
        return stub
            .withDeadline(Deadline.after(300, TimeUnit.SECONDS))
            .downloadAndProcess(request)
    }

    suspend fun downloadOnly(request: DownloadOnlyRequest): DownloadResponse {
        logger.info { "gRPC DownloadOnly: title=${request.title}" }
        return stub
            .withDeadline(Deadline.after(300, TimeUnit.SECONDS))
            .downloadOnly(request)
    }

    suspend fun redownloadForDocument(request: RedownloadForDocumentRequest): DownloadResponse {
        logger.info { "gRPC RedownloadForDocument: documentId=${request.documentId}" }
        return stub
            .withDeadline(Deadline.after(300, TimeUnit.SECONDS))
            .redownloadForDocument(request)
    }

    suspend fun processBooks(request: ProcessBooksRequest): ProcessBooksResponse {
        logger.info { "gRPC ProcessBooks: ${request.documentIdsList.size} documents" }
        return stub.processBooks(request)
    }

    suspend fun previewBook(request: PreviewBookRequest): PreviewResponse {
        logger.info { "gRPC PreviewBook: title=${request.title}" }
        return stub.previewBook(request)
    }

    suspend fun servePreviewFile(request: PreviewFileRequest): PreviewFileResponse {
        logger.info { "gRPC ServePreviewFile: file=${request.fileId}" }
        return stub.servePreviewFile(request)
    }

    suspend fun deletePreviewFile(request: PreviewFileRequest): StatusResponse {
        logger.info { "gRPC DeletePreviewFile: file=${request.fileId}" }
        return stub.deletePreviewFile(request)
    }
}
