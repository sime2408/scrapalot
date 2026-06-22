package com.scrapalot.backend.config

import com.scrapalot.backend.grpc.admin.AdminServiceGrpcKt
import com.scrapalot.backend.grpc.ai.DocumentCollectionServiceGrpcKt
import com.scrapalot.backend.grpc.ai.DocumentProcessingServiceGrpcKt
import com.scrapalot.backend.grpc.chat.ChatServiceGrpcKt
import com.scrapalot.backend.grpc.collection.CollectionAIServiceGrpcKt
import com.scrapalot.backend.grpc.connectors.ConnectorServiceGrpcKt
import com.scrapalot.backend.grpc.desktop.DesktopServiceGrpcKt
import com.scrapalot.backend.grpc.document.DocumentExtrasServiceGrpcKt
import com.scrapalot.backend.grpc.external_books.ExternalBooksServiceGrpcKt
import com.scrapalot.backend.grpc.inspection.InspectionServiceGrpcKt
import com.scrapalot.backend.grpc.jobs.JobsServiceGrpcKt
import com.scrapalot.backend.grpc.llm.LlmInferenceServiceGrpcKt
import com.scrapalot.backend.grpc.notes_assistant.NotesAssistantServiceGrpcKt
import com.scrapalot.backend.grpc.paper.PaperServiceGrpcKt
import com.scrapalot.backend.grpc.research.ResearchDataServiceGrpcKt
import com.scrapalot.backend.grpc.settings.SettingsAIServiceGrpcKt
import com.scrapalot.backend.grpc.stt.SttServiceGrpcKt
import com.scrapalot.backend.grpc.tts.TtsServiceGrpcKt
import net.devh.boot.grpc.client.inject.GrpcClient
import net.devh.boot.grpc.server.security.authentication.GrpcAuthenticationReader
import net.devh.boot.grpc.server.serverfactory.GrpcServerConfigurer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.util.concurrent.TimeUnit

/**
 * gRPC Configuration
 *
 * Configures:
 * 1. gRPC Server - Python and Gateway connect TO this (port 9090)
 * 2. gRPC Client - Kotlin connects TO Python CHAT for AI operations (port 9091)
 */
@Configuration
class GrpcConfig {
    @Bean
    fun grpcServerConfigurer(): GrpcServerConfigurer =
        GrpcServerConfigurer { serverBuilder ->
            serverBuilder
                .maxInboundMessageSize(10 * 1024 * 1024) // 10MB
                .maxInboundMetadataSize(8 * 1024) // 8KB
                .keepAliveTime(30, TimeUnit.SECONDS)
                .keepAliveTimeout(10, TimeUnit.SECONDS)
                .permitKeepAliveWithoutCalls(true)
                .permitKeepAliveTime(10, TimeUnit.SECONDS)
        }

    /**
     * gRPC authentication reader for internal service-to-service communication.
     *
     * Returns null to allow unauthenticated access - the gRPC services are for
     * internal Python-Kotlin communication, not for external clients.
     * Authentication is handled at the REST API layer for external requests.
     */
    @Bean
    fun grpcAuthenticationReader(): GrpcAuthenticationReader =
        GrpcAuthenticationReader { _, _ ->
            // Allow internal service communication without authentication
            // Python service will handle user auth validation via gRPC calls to AuthService
            null
        }

    /**
     * ChatService gRPC Client Stub
     *
     * Coroutine-based stub for calling Python CHAT service.
     * Connection configured via application.yaml: grpc.client.python-chat
     *
     * Usage in services:
     * ```
     * @Service
     * class ChatService(private val chatServiceStub: ChatServiceGrpcKt.ChatServiceCoroutineStub) {
     *     suspend fun generateChat(request: ChatRequest): Flow<ChatResponsePacket> {
     *         return chatServiceStub.generateChat(request)
     *     }
     * }
     * ```
     */
    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun chatServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): ChatServiceGrpcKt.ChatServiceCoroutineStub = ChatServiceGrpcKt.ChatServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun jobsServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): JobsServiceGrpcKt.JobsServiceCoroutineStub = JobsServiceGrpcKt.JobsServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun adminServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): AdminServiceGrpcKt.AdminServiceCoroutineStub = AdminServiceGrpcKt.AdminServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun ttsServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): TtsServiceGrpcKt.TtsServiceCoroutineStub = TtsServiceGrpcKt.TtsServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun sttServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): SttServiceGrpcKt.SttServiceCoroutineStub = SttServiceGrpcKt.SttServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun researchDataServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): ResearchDataServiceGrpcKt.ResearchDataServiceCoroutineStub = ResearchDataServiceGrpcKt.ResearchDataServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun collectionAIServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): CollectionAIServiceGrpcKt.CollectionAIServiceCoroutineStub = CollectionAIServiceGrpcKt.CollectionAIServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun settingsAIServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): SettingsAIServiceGrpcKt.SettingsAIServiceCoroutineStub = SettingsAIServiceGrpcKt.SettingsAIServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun llmInferenceServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): LlmInferenceServiceGrpcKt.LlmInferenceServiceCoroutineStub = LlmInferenceServiceGrpcKt.LlmInferenceServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun documentExtrasServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): DocumentExtrasServiceGrpcKt.DocumentExtrasServiceCoroutineStub = DocumentExtrasServiceGrpcKt.DocumentExtrasServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun externalBooksServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): ExternalBooksServiceGrpcKt.ExternalBooksServiceCoroutineStub = ExternalBooksServiceGrpcKt.ExternalBooksServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun desktopServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): DesktopServiceGrpcKt.DesktopServiceCoroutineStub = DesktopServiceGrpcKt.DesktopServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun connectorServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): ConnectorServiceGrpcKt.ConnectorServiceCoroutineStub = ConnectorServiceGrpcKt.ConnectorServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun mcpServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): com.scrapalot.backend.grpc.mcp.McpServiceGrpcKt.McpServiceCoroutineStub =
        com.scrapalot.backend.grpc.mcp.McpServiceGrpcKt
            .McpServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun inspectionServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): InspectionServiceGrpcKt.InspectionServiceCoroutineStub = InspectionServiceGrpcKt.InspectionServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun documentProcessingServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): DocumentProcessingServiceGrpcKt.DocumentProcessingServiceCoroutineStub = DocumentProcessingServiceGrpcKt.DocumentProcessingServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun documentCollectionServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): DocumentCollectionServiceGrpcKt.DocumentCollectionServiceCoroutineStub = DocumentCollectionServiceGrpcKt.DocumentCollectionServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun notesAssistantServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): NotesAssistantServiceGrpcKt.NotesAssistantServiceCoroutineStub = NotesAssistantServiceGrpcKt.NotesAssistantServiceCoroutineStub(channel)

    @Bean
    @Suppress("SpringJavaInjectionPointsAutowiringInspection")
    fun paperServiceStub(
        @GrpcClient("python-chat") channel: io.grpc.Channel
    ): PaperServiceGrpcKt.PaperServiceCoroutineStub = PaperServiceGrpcKt.PaperServiceCoroutineStub(channel)
}
