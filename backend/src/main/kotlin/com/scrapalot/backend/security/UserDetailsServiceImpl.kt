package com.scrapalot.backend.security

import com.scrapalot.backend.repository.UserRepository
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.core.userdetails.UsernameNotFoundException
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

@Service
class UserDetailsServiceImpl(
    private val userRepository: UserRepository
) : UserDetailsService {
    @Transactional(readOnly = true)
    override fun loadUserByUsername(username: String): UserDetails {
        val user =
            userRepository.findByEmailOrUsername(username)
                ?: throw UsernameNotFoundException("User not found with username or email: $username")
        return buildUserDetails(user) { "User is not active: $username" }
    }

    @Transactional(readOnly = true)
    fun loadUserById(userId: UUID): UserDetails {
        val user =
            userRepository.findById(userId).orElse(null)
                ?: throw UsernameNotFoundException("User not found with ID: $userId")
        return buildUserDetails(user) { "User is not active: $userId" }
    }

    private fun buildUserDetails(
        user: com.scrapalot.backend.domain.auth.User,
        inactiveMessage: () -> String,
    ): UserDetails {
        if (!user.isActive) throw UsernameNotFoundException(inactiveMessage())
        val authorities = listOf(SimpleGrantedAuthority("ROLE_${user.role.uppercase()}"))
        return org.springframework.security.core.userdetails.User(
            user.email ?: user.username ?: throw UsernameNotFoundException("User has no email or username"),
            user.password ?: "",
            user.isActive,
            true,
            true,
            true,
            authorities,
        )
    }
}
