package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.workspace.AnnotationColorSemantics
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface AnnotationColorSemanticsRepository : JpaRepository<AnnotationColorSemantics, UUID>
