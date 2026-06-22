package com.scrapalot.backend.grpc

import com.scrapalot.backend.grpc.jobs.*
import mu.KotlinLogging
import org.springframework.stereotype.Service

private val logger = KotlinLogging.logger {}

/**
 * gRPC client for Python JobsService.
 *
 * Job tracking is owned by Python (in-memory + database).
 * Kotlin queries job status via gRPC.
 */
@Service
class JobsGrpcClient(
    private val stub: JobsServiceGrpcKt.JobsServiceCoroutineStub
) {
    suspend fun getActiveJobs(request: GetActiveJobsRequest): GetActiveJobsResponse {
        logger.info { "gRPC GetActiveJobs: user_id=${request.userId}" }
        return stub.getActiveJobs(request)
    }

    suspend fun getJobStatus(request: GetJobStatusRequest): JobStatusResponse {
        logger.info { "gRPC GetJobStatus: job_id=${request.jobId}, user_id=${request.userId}" }
        return stub.getJobStatus(request)
    }

    suspend fun cancelJob(request: CancelJobRequest): com.scrapalot.backend.grpc.common.StatusResponse {
        logger.info { "gRPC CancelJob: job_id=${request.jobId}, user_id=${request.userId}" }
        return stub.cancelJob(request)
    }
}
