package com.scrapalot.backend.controller.auth

import com.scrapalot.backend.domain.auth.User
import com.scrapalot.backend.dto.LoginRequest
import com.scrapalot.backend.dto.RegisterRequest
import com.scrapalot.backend.dto.TokenResponse
import com.scrapalot.backend.dto.UserResponse
import com.scrapalot.backend.service.AuthService
import com.scrapalot.backend.utils.onFailureLog
import com.scrapalot.backend.utils.onSuccessLog
import com.scrapalot.backend.utils.orThrow
import com.scrapalot.backend.utils.resultOf
import com.scrapalot.backend.utils.toResponseEntity
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/users")
class LoginController(
    private val authService: AuthService
) {
    @PostMapping("/token")
    fun loginForAccessToken(
        @Valid @RequestBody request: LoginRequest
    ): ResponseEntity<TokenResponse> =
        resultOf {
            authService.login(request.usernameOrEmail, request.password)
        }.onFailureLog { "Login failed: ${it.message}" }
            .toResponseEntity()

    @PostMapping("/register")
    fun register(
        @Valid @RequestBody request: RegisterRequest
    ): ResponseEntity<UserResponse> =
        resultOf {
            authService
                .register(
                    username = request.username,
                    email = request.email,
                    password = request.password,
                    firstName = request.firstName,
                    lastName = request.lastName,
                    licenseAgreementConsent = request.licenseAgreementConsent,
                    contentSharingConsent = request.contentSharingConsent
                ).toResponse()
        }.onSuccessLog { "User registered: ${it.username}" }
            .toResponseEntity(HttpStatus.CREATED)
}

private fun User.toResponse() =
    UserResponse(
        id = id.orThrow("Entity"),
        username = username,
        email = email,
        firstName = firstName,
        lastName = lastName,
        role = role,
        isActive = isActive,
        isExternal = isExternal,
        profilePicture = profilePicture,
        licenseAgreementConsent = licenseAgreementConsent,
        contentSharingConsent = contentSharingConsent,
        tourCompleted = tourCompleted,
        createdAt = createdAt.toString(),
        updatedAt = updatedAt.toString()
    )
