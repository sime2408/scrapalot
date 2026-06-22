package com.scrapalot.backend.repository

import com.scrapalot.backend.domain.auth.User
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
interface UserRepository : JpaRepository<User, UUID> {
    fun findByUsername(username: String): User?

    fun findByEmail(email: String): User?

    fun existsByUsername(username: String): Boolean

    fun existsByEmail(email: String): Boolean

    @Query("SELECT u FROM User u WHERE (u.email = :identifier OR u.username = :identifier) AND u.isActive = true")
    fun findByEmailOrUsername(
        @Param("identifier") identifier: String
    ): User?

    @Query(
        "SELECT u FROM User u WHERE u.isActive = true AND u.id != :excludeUserId AND (LOWER(u.email) LIKE LOWER(CONCAT('%', :query, '%')) OR LOWER(u.username) LIKE LOWER(CONCAT('%', :query, '%')))"
    )
    fun searchUsers(
        @Param("query") query: String,
        @Param("excludeUserId") excludeUserId: UUID
    ): List<User>

    // Same as searchUsers but WITHOUT the isActive filter — for admin user
    // management, which must surface deactivated users so they can be
    // reactivated. Share/invite flows keep using searchUsers (active only).
    @Query(
        "SELECT u FROM User u WHERE u.id != :excludeUserId AND (LOWER(u.email) LIKE LOWER(CONCAT('%', :query, '%')) OR LOWER(u.username) LIKE LOWER(CONCAT('%', :query, '%')))"
    )
    fun searchAllUsers(
        @Param("query") query: String,
        @Param("excludeUserId") excludeUserId: UUID
    ): List<User>

    fun findByIsActive(isActive: Boolean): List<User>
}
