package com.scrapalot.backend.mapper

import com.scrapalot.backend.domain.workspace.Workspace
import com.scrapalot.backend.dto.WorkspaceResponse
import org.mapstruct.Mapper
import org.mapstruct.Mapping
import org.mapstruct.ReportingPolicy

/**
 * MapStruct mapper for Workspace entity and DTOs
 */
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface WorkspaceMapper {
    /**
     * Convert Workspace entity to WorkspaceResponse DTO
     */
    @Mapping(target = "settings", expression = "java(java.util.Collections.emptyMap())")
    fun toWorkspaceResponse(workspace: Workspace): WorkspaceResponse

    /**
     * Convert list of Workspace entities to a list of WorkspaceResponse DTOs
     */
    fun toWorkspaceResponseList(workspaces: List<Workspace>): List<WorkspaceResponse>
}
