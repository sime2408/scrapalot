# OpenAPI Documentation - Kotlin Backend

**Version**: 1.0.0
**Last Updated**: March 2026

Complete guide to OpenAPI/Swagger documentation in the Kotlin backend service.

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Configuration](#configuration)
3. [Accessing Documentation](#accessing-documentation)
4. [API Endpoints](#api-endpoints)
5. [Authentication](#authentication)
6. [Annotations](#annotations)
7. [Customization](#customization)
8. [Best Practices](#best-practices)

---

## Overview

The Kotlin backend uses **Springdoc OpenAPI 3** for the schema/`OpenAPI` bean (`OpenAPIConfig`), but the `/v3/api-docs` JSON is served by a **manual `OpenApiController`** (with `OpenApiPathsCustomizer`) because Springdoc autoconfiguration does not work with the WebMVC + WebFlux hybrid setup.

**Technology Stack:**
- **Springdoc OpenAPI**: 2.7.0 (WebFlux version)
- **OpenAPI Specification**: 3.0.x
- **Swagger UI**: Embedded interactive documentation
- **Format**: JSON/YAML

**Why WebFlux Version?**
- Backend uses both `spring-boot-starter-web` (for REST) and `spring-boot-starter-webflux` (for reactive HTTP client)
- Springdoc requires WebFlux version when both starters are present
- Provides same functionality with reactive compatibility

---

## Configuration

### Application Configuration

**File**: `src/main/resources/application.yml`

```yaml
# Springdoc OpenAPI Configuration
springdoc:
  api-docs:
    enabled: true                           # Enable OpenAPI JSON generation
    path: /v3/api-docs                      # OpenAPI JSON endpoint
  swagger-ui:
    enabled: true                           # Enable Swagger UI
    path: /swagger-ui.html                  # Swagger UI path
    operations-sorter: alpha                # Sort operations alphabetically
    tags-sorter: alpha                      # Sort tags alphabetically
    disable-swagger-default-url: true       # Disable default URL
```

### Security Configuration

**File**: `src/main/kotlin/com/scrapalot/backend/security/SecurityConfig.kt`

```kotlin
@Configuration
@EnableWebSecurity
class SecurityConfig {

    @Bean
    fun securityFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .authorizeHttpRequests { auth ->
                auth
                    // Public endpoints (no authentication required)
                    .requestMatchers("/v3/api-docs/**").permitAll()
                    .requestMatchers("/swagger-ui/**").permitAll()
                    .requestMatchers("/swagger-ui.html").permitAll()

                    // Protected endpoints
                    .anyRequest().authenticated()
            }

        return http.build()
    }
}
```

### Dependencies

**File**: `build.gradle.kts`

```kotlin
dependencies {
    // OpenAPI Documentation (WebFlux version)
    implementation("org.springdoc:springdoc-openapi-starter-webflux-ui:2.7.0")
}
```

---

## Accessing Documentation

### Local Development

**Swagger UI** (Interactive):
```
http://localhost:8091/swagger-ui.html
```

**OpenAPI JSON**:
```
http://localhost:8091/v3/api-docs
```

**OpenAPI YAML**:
```
http://localhost:8091/v3/api-docs.yaml
```

### Production

**Through API Gateway**:
```
https://api.scrapalot.app/swagger-ui.html
https://api.scrapalot.app/v3/api-docs
```

**Direct (if exposed)**:
```
https://backend.scrapalot.app/swagger-ui.html
https://backend.scrapalot.app/v3/api-docs
```

---

## API Endpoints

### Documentation URLs

| URL | Description | Format |
|-----|-------------|--------|
| `/swagger-ui.html` | Interactive Swagger UI | HTML |
| `/swagger-ui/index.html` | Alternative Swagger UI path | HTML |
| `/v3/api-docs` | OpenAPI specification | JSON |
| `/v3/api-docs.yaml` | OpenAPI specification | YAML |

### API Tag Groups

All endpoints are organized by functional areas:

| Tag | Description | Controllers |
|-----|-------------|-------------|
| **Authentication** | User auth, JWT tokens | AuthController, LoginController, TokenController |
| **Users** | User management | UserController |
| **Workspaces** | Workspace CRUD | WorkspaceController |
| **Collections** | Collection management | CollectionController |
| **Documents** | Document metadata | DocumentController |
| **Chat** | AI chat generation | ChatController, SessionController, MessageController |
| **Notes** | Collaborative notes | NoteController, NoteCollaborationController |
| **Settings** | User/server settings | SettingsController |
| **Subscriptions** | Billing & subscriptions | SubscriptionsController |
| **Admin** | Admin utilities | AdminController, AdminDebugController, AdminEmailController, AdminInspectorController |

---

## Authentication

### Security Scheme

**Type**: HTTP Bearer Token (JWT)

```yaml
securitySchemes:
  bearerAuth:
    type: http
    scheme: bearer
    bearerFormat: JWT
    description: JWT token obtained from /api/v1/auth/login
```

### Using Authentication in Swagger UI

1. Click **"Authorize"** button (🔓 icon)
2. Enter JWT token: `Bearer <your-jwt-token>`
3. Click **"Authorize"**
4. All subsequent requests will include the token

### Getting a JWT Token

**Endpoint**: `POST /api/v1/auth/login`

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 86400
}
```

---

## Annotations

### Controller Level

```kotlin
@RestController
@RequestMapping("/api/v1/workspaces")
@Tag(name = "Workspaces", description = "Workspace management endpoints")
@SecurityRequirement(name = "bearerAuth")
class WorkspaceController {
    // ...
}
```

**Annotations:**
- `@Tag` - Groups endpoints in Swagger UI
- `@SecurityRequirement` - Indicates authentication required

### Operation Level

```kotlin
@PostMapping
@Operation(
    summary = "Create a new workspace",
    description = "Creates a new workspace for the authenticated user"
)
@ApiResponses(
    value = [
        ApiResponse(
            responseCode = "201",
            description = "Workspace created successfully",
            content = [Content(schema = Schema(implementation = WorkspaceDTO::class))]
        ),
        ApiResponse(
            responseCode = "400",
            description = "Invalid request body"
        ),
        ApiResponse(
            responseCode = "401",
            description = "Unauthorized - JWT token missing or invalid"
        )
    ]
)
fun createWorkspace(
    @AuthenticationPrincipal userDetails: UserDetails,
    @RequestBody @Valid request: CreateWorkspaceRequest
): ResponseEntity<WorkspaceDTO> {
    // ...
}
```

**Annotations:**
- `@Operation` - Describes the endpoint
- `@ApiResponses` - Documents possible responses
- `@Parameter` - Documents request parameters
- `@RequestBody` - Documents request body
- `@Valid` - Triggers validation (documented in schema)

### Schema Documentation

```kotlin
@Schema(description = "Request to create a new workspace")
data class CreateWorkspaceRequest(

    @field:Schema(
        description = "Workspace name",
        example = "My Workspace",
        required = true,
        minLength = 3,
        maxLength = 100
    )
    @field:NotBlank(message = "Name is required")
    @field:Size(min = 3, max = 100)
    val name: String,

    @field:Schema(
        description = "Workspace description",
        example = "A workspace for my documents",
        required = false,
        maxLength = 500
    )
    @field:Size(max = 500)
    val description: String? = null
)
```

---

## Customization

### Custom OpenAPI Configuration

**File**: `src/main/kotlin/com/scrapalot/backend/config/OpenAPIConfig.kt`

```kotlin
@Configuration
class OpenAPIConfig {

    @field:Value("\${server.servlet.context-path:/api/v1}")
    private val contextPath: String = "/api/v1"

    // injected active Spring profile ("prod" or "dev")
    private val activeProfile: String = "dev"

    @Bean
    fun openAPI(): OpenAPI {
        // single server chosen by profile: prod -> https://api.scrapalot.app + contextPath,
        // else http://localhost:8091 + contextPath
        val serverUrl =
            if (activeProfile == "prod") "https://api.scrapalot.app$contextPath"
            else "http://localhost:8091$contextPath"
        return OpenAPI()
            .info(
                Info()
                    .title("Scrapalot Backend API")
                    .version("1.0.0")
                    .description("REST API for Scrapalot backend services")
                    .contact(
                        Contact()
                            .name("Scrapalot Team")
                            .email("support@mail.scrapalot.app")
                            .url("https://scrapalot.app")
                    )
                    .license(
                        License()
                            .name("Proprietary")
                            .url("https://scrapalot.app")
                    )
            )
            .servers(
                listOf(
                    Server()
                        .url(serverUrl)
                        .description("${activeProfile.uppercase()} Server")
                )
            )
            .components(
                Components()
                    .addSecuritySchemes(
                        "bearerAuth",
                        SecurityScheme()
                            .type(SecurityScheme.Type.HTTP)
                            .scheme("bearer")
                            .bearerFormat("JWT")
                            .description("JWT token from /api/v1/auth/login")
                    )
            )
    }
}
```

### Customizing Swagger UI

**File**: `application.yml`

```yaml
springdoc:
  swagger-ui:
    # UI Customization
    display-request-duration: true          # Show request duration
    try-it-out-enabled: true                # Enable "Try it out" by default
    show-extensions: true                   # Show vendor extensions
    show-common-extensions: true            # Show common extensions

    # URL Configuration
    url: /v3/api-docs                       # OpenAPI JSON URL
    config-url: /v3/api-docs/swagger-config # Swagger config URL

    # Sorting
    operations-sorter: alpha                # alpha, method
    tags-sorter: alpha                      # alpha

    # Filters
    filter: true                            # Enable tag filter

    # Request/Response Display
    default-models-expand-depth: 1          # Model expand depth
    default-model-expand-depth: 1           # Nested model depth
    display-operation-id: false             # Show operation IDs
```

---

## Best Practices

### 1. Comprehensive Documentation

**DO:**
```kotlin
@Operation(
    summary = "Get workspace by ID",
    description = """
        Retrieves a workspace by its unique identifier.
        The authenticated user must have access to the workspace.
    """
)
@ApiResponses(
    value = [
        ApiResponse(responseCode = "200", description = "Workspace found"),
        ApiResponse(responseCode = "404", description = "Workspace not found"),
        ApiResponse(responseCode = "403", description = "Access denied")
    ]
)
fun getWorkspace(@PathVariable id: UUID): WorkspaceDTO
```

**DON'T:**
```kotlin
fun getWorkspace(@PathVariable id: UUID): WorkspaceDTO  // No documentation
```

### 2. Validate Request Bodies

```kotlin
data class CreateUserRequest(
    @field:NotBlank
    @field:Email
    val email: String,

    @field:NotBlank
    @field:Size(min = 8, max = 100)
    val password: String
)
```

### 3. Use Meaningful Examples

```kotlin
@Schema(
    description = "User email address",
    example = "user@example.com",
    format = "email"
)
val email: String
```

### 4. Document Error Responses

```kotlin
@ApiResponses(
    value = [
        ApiResponse(responseCode = "200", description = "Success"),
        ApiResponse(
            responseCode = "400",
            description = "Invalid input",
            content = [Content(schema = Schema(implementation = ErrorResponse::class))]
        ),
        ApiResponse(
            responseCode = "401",
            description = "Unauthorized"
        )
    ]
)
```

### 5. Hide Internal Endpoints

```kotlin
@RestController
@RequestMapping("/internal")
@Hidden  // Hides from OpenAPI documentation
class InternalController {
    // ...
}
```

### 6. Group Related Endpoints

```kotlin
@Tag(name = "Workspaces", description = "Workspace management")
class WorkspaceController

@Tag(name = "Collections", description = "Collection management")
class CollectionController
```

---

## Example: Complete Controller Documentation

```kotlin
package com.scrapalot.backend.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.media.Content
import io.swagger.v3.oas.annotations.media.Schema
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.validation.annotation.Validated
import org.springframework.web.bind.annotation.*
import java.util.UUID
import javax.validation.Valid

@RestController
@RequestMapping("/api/v1/workspaces")
@Tag(
    name = "Workspaces",
    description = "Workspace management endpoints for creating, reading, updating, and deleting workspaces"
)
@SecurityRequirement(name = "bearerAuth")
@Validated
class WorkspaceController(
    private val workspaceService: WorkspaceService
) {

    @GetMapping
    @Operation(
        summary = "List all workspaces",
        description = "Retrieves all workspaces accessible by the authenticated user"
    )
    @ApiResponses(
        value = [
            ApiResponse(
                responseCode = "200",
                description = "List of workspaces",
                content = [Content(schema = Schema(implementation = Array<WorkspaceDTO>::class))]
            ),
            ApiResponse(responseCode = "401", description = "Unauthorized")
        ]
    )
    fun listWorkspaces(
        @AuthenticationPrincipal userDetails: UserDetails
    ): ResponseEntity<List<WorkspaceDTO>> {
        val workspaces = workspaceService.listWorkspaces(userDetails.username)
        return ResponseEntity.ok(workspaces)
    }

    @PostMapping
    @Operation(
        summary = "Create workspace",
        description = "Creates a new workspace for the authenticated user"
    )
    @ApiResponses(
        value = [
            ApiResponse(
                responseCode = "201",
                description = "Workspace created",
                content = [Content(schema = Schema(implementation = WorkspaceDTO::class))]
            ),
            ApiResponse(responseCode = "400", description = "Invalid request"),
            ApiResponse(responseCode = "401", description = "Unauthorized")
        ]
    )
    fun createWorkspace(
        @AuthenticationPrincipal userDetails: UserDetails,
        @RequestBody @Valid request: CreateWorkspaceRequest
    ): ResponseEntity<WorkspaceDTO> {
        val workspace = workspaceService.createWorkspace(userDetails.username, request)
        return ResponseEntity.status(HttpStatus.CREATED).body(workspace)
    }

    @GetMapping("/{id}")
    @Operation(
        summary = "Get workspace by ID",
        description = "Retrieves a specific workspace by its unique identifier"
    )
    @ApiResponses(
        value = [
            ApiResponse(
                responseCode = "200",
                description = "Workspace found",
                content = [Content(schema = Schema(implementation = WorkspaceDTO::class))]
            ),
            ApiResponse(responseCode = "404", description = "Workspace not found"),
            ApiResponse(responseCode = "403", description = "Access denied")
        ]
    )
    fun getWorkspace(
        @Parameter(description = "Workspace UUID", required = true)
        @PathVariable id: UUID
    ): ResponseEntity<WorkspaceDTO> {
        val workspace = workspaceService.getWorkspace(id)
        return ResponseEntity.ok(workspace)
    }
}
```

---

## Troubleshooting

### Issue: Swagger UI Not Loading

**Check**:
1. Verify `springdoc.swagger-ui.enabled=true` in `application.yml`
2. Check security configuration allows `/swagger-ui/**`
3. Try alternative path: `/swagger-ui/index.html`
4. Check browser console for JavaScript errors

### Issue: Endpoints Not Appearing

**Solutions**:
1. Ensure controller has `@RestController` annotation
2. Add `@Tag` annotation to group endpoints
3. Check if endpoint is marked with `@Hidden`
4. Verify Spring component scanning includes controller package

### Issue: Authentication Not Working

**Solutions**:
1. Click "Authorize" button in Swagger UI
2. Enter token with "Bearer " prefix: `Bearer eyJhbGci...`
3. Verify JWT token is valid (not expired)
4. Check security configuration allows authenticated endpoints

---

## Related Documentation

- [README_ARCHITECTURE.md](./README_ARCHITECTURE.md) - System architecture
- [README_DEPLOYMENT_GUIDE.md](./README_DEPLOYMENT_GUIDE.md) - Deployment procedures
- [Springdoc OpenAPI Documentation](https://springdoc.org/) - Official Springdoc docs

---

**Version**: 1.0.0
**Last Updated**: March 2026
