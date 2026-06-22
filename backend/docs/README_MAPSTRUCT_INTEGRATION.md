# MapStruct Integration Guide

**Version**: 1.1.0
**Last Updated**: March 2026

## Overview

**Note**: This guide is specific to **Kotlin Backend** - Python CHAT does not use MapStruct.

Scrapalot Kotlin Backend uses **MapStruct 1.6.3** for type-safe, compile-time DTO-to-Entity mapping. This eliminates manual mapping code, reduces boilerplate, and provides better performance than reflection-based mappers.

**Architecture Context**: In the new architecture, Kotlin Backend handles ALL user-facing DTOs and entity mappings. Python CHAT works with simple data structures for AI/ML tasks.

## Architecture

### Mapper Interfaces

All mappers are located in `src/main/kotlin/com/scrapalot/backend/mapper/` and follow a consistent pattern:

```kotlin
@Mapper(
    componentModel = "spring",
    unmappedTargetPolicy = ReportingPolicy.IGNORE
)
interface UserMapper {
    fun toUserResponse(user: User): UserResponse
    fun toUserResponseList(users: List<User>): List<UserResponse>
    fun updateUserFromDto(request: UpdateUserRequest, @MappingTarget user: User)
}
```

### Available Mappers

1. **AuthMapper** - Authentication and API key mappings
2. **UserMapper** - User entity mappings
3. **WorkspaceMapper** - Workspace entity mappings
4. **CollectionMapper** - Collection entity mappings
5. **NoteMapper** - Note, version, comment, and share mappings
6. **SettingsMapper** - User and server settings mappings
7. **AnnotationMapper** - Document annotation mappings
8. **ConnectorMapper** - External connector entity mappings
9. **MessageMapper** - Chat message mappings
10. **SessionMapper** - Chat session mappings

## Configuration

### build.gradle.kts

MapStruct is configured with Kotlin Annotation Processing Tool (kapt):

```kotlin
plugins {
    kotlin("kapt") version "2.1.0"
}

dependencies {
    implementation("org.mapstruct:mapstruct:1.6.3")
    kapt("org.mapstruct:mapstruct-processor:1.6.3")
}

kapt {
    arguments {
        arg("mapstruct.defaultComponentModel", "spring")
        arg("mapstruct.unmappedTargetPolicy", "IGNORE")
    }
}
```

**Key Configuration:**
- `componentModel = "spring"` - Mappers are Spring beans (injectable)
- `unmappedTargetPolicy = "IGNORE"` - Ignores unmapped fields (safer for DTOs)

### Build Process

MapStruct generates implementation classes during compilation:

```bash
./gradlew clean build

# Generated classes location:
# build/generated/source/kapt/main/com/scrapalot/backend/mapper/
```

**Generated classes:**
- `UserMapperImpl`
- `WorkspaceMapperImpl`
- `CollectionMapperImpl`
- etc.

## Usage in Services

### Dependency Injection

Inject mappers into services via constructor injection:

```kotlin
@Service
class UserService(
    private val userRepository: UserRepository,
    private val userMapper: UserMapper  // MapStruct-generated Spring bean
) {
    fun getUser(userId: UUID): UserResponse {
        val user = userRepository.findById(userId)
            .orElseThrow { NotFoundException("User not found") }
        return userMapper.toUserResponse(user)
    }
}
```

### Entity to DTO Mapping

**Single entity:**
```kotlin
val user: User = userRepository.findById(userId).get()
val response: UserResponse = userMapper.toUserResponse(user)
```

**List of entities:**
```kotlin
val users: List<User> = userRepository.findAll()
val responses: List<UserResponse> = userMapper.toUserResponseList(users)
```

### DTO to Entity Mapping

**Creating new entities:**
```kotlin
val workspace = workspaceMapper.toWorkspace(
    request = CreateWorkspaceRequest(name = "My Workspace"),
    userId = currentUserId
)
workspaceRepository.save(workspace)
```

### Updating Existing Entities

**Using @MappingTarget:**
```kotlin
val user = userRepository.findById(userId).get()
userMapper.updateUserFromDto(
    request = UpdateUserRequest(username = "newname"),
    user = user  // Updated in-place
)
userRepository.save(user)
```

### Complex Mappings with Multiple Sources

**Token response with multiple sources:**
```kotlin
val user: User = userRepository.findByEmail(email).get()
val accessToken = jwtTokenProvider.generateAccessToken(user.username)
val refreshToken = jwtTokenProvider.generateRefreshToken(user.username)

val response = authMapper.toTokenResponse(
    user = user,
    accessToken = accessToken,
    refreshToken = refreshToken
)
```

**API key with full key:**
```kotlin
val apiKey = apiKeyRepository.save(newAPIKey)
val fullKey = "scp-${apiKey.prefix}-${generatedSecret}"

val response = authMapper.toAPIKeyCreatedResponse(
    apiKey = apiKey,
    fullKey = fullKey  // Only shown once
)
```

## Service Examples

### UserService with MapStruct

```kotlin
@Service
@Transactional
class UserService(
    private val userRepository: UserRepository,
    private val userMapper: UserMapper,
    private val passwordEncoder: PasswordEncoder
) {

    fun getUser(userId: UUID): UserResponse {
        val user = userRepository.findById(userId)
            .orElseThrow { NotFoundException("User not found") }
        return userMapper.toUserResponse(user)
    }

    fun getAllUsers(): List<UserResponse> {
        val users = userRepository.findAll()
        return userMapper.toUserResponseList(users)
    }

    fun updateUser(userId: UUID, request: UpdateUserRequest): UserResponse {
        val user = userRepository.findById(userId)
            .orElseThrow { NotFoundException("User not found") }

        userMapper.updateUserFromDto(request, user)
        val updated = userRepository.save(user)

        return userMapper.toUserResponse(updated)
    }
}
```

### NoteService with Complex Mappings

```kotlin
@Service
@Transactional
class NoteService(
    private val noteRepository: NoteRepository,
    private val noteVersionRepository: NoteVersionRepository,
    private val noteCommentRepository: NoteCommentRepository,
    private val noteMapper: NoteMapper
) {

    fun createNote(
        collectionId: UUID,
        userId: UUID,
        request: CreateNoteRequest
    ): NoteResponse {
        // Create note using mapper
        val note = noteMapper.toNote(
            request = request,
            collectionId = collectionId,
            userId = userId
        )
        val saved = noteRepository.save(note)

        // Create initial version
        createVersion(saved.id!!, userId, request.content ?: "", "Initial version")

        return noteMapper.toNoteResponse(saved)
    }

    fun getNoteVersions(noteId: UUID): List<NoteVersionResponse> {
        val versions = noteVersionRepository.findByNoteIdOrderByVersionNumberDesc(noteId)
        return noteMapper.toNoteVersionResponseList(versions)
    }

    fun addComment(
        noteId: UUID,
        userId: UUID,
        request: AddCommentRequest
    ): NoteCommentResponse {
        val comment = noteMapper.toNoteComment(
            request = request,
            noteId = noteId,
            userId = userId
        )
        val saved = noteCommentRepository.save(comment)

        return noteMapper.toNoteCommentResponse(saved)
    }
}
```

### AuthService with Token Generation

```kotlin
@Service
@Transactional
class AuthService(
    private val userRepository: UserRepository,
    private val apiKeyRepository: APIKeyRepository,
    private val authMapper: AuthMapper,
    private val jwtTokenProvider: JwtTokenProvider,
    private val passwordEncoder: PasswordEncoder
) {

    fun login(usernameOrEmail: String, password: String): TokenResponse {
        val user = userRepository.findByEmailOrUsername(usernameOrEmail)
            ?: throw UnauthorizedException("Invalid credentials")

        if (!passwordEncoder.matches(password, user.password)) {
            throw UnauthorizedException("Invalid credentials")
        }

        val accessToken = jwtTokenProvider.generateAccessToken(user.username!!)
        val refreshToken = jwtTokenProvider.generateRefreshToken(user.username!!)

        return authMapper.toTokenResponse(
            user = user,
            accessToken = accessToken,
            refreshToken = refreshToken
        )
    }

    fun createAPIKey(
        userId: UUID,
        request: CreateAPIKeyRequest
    ): APIKeyCreatedResponse {
        val secret = generateSecureSecret()
        val prefix = generatePrefix()
        val fullKey = "scp-$prefix-$secret"
        val hashedKey = passwordEncoder.encode(fullKey)

        val apiKey = APIKey(
            userId = userId,
            name = request.name,
            keyHash = hashedKey,
            prefix = prefix,
            expiresAt = request.expiresAt
        )
        val saved = apiKeyRepository.save(apiKey)

        return authMapper.toAPIKeyCreatedResponse(
            apiKey = saved,
            fullKey = fullKey
        )
    }
}
```

## Mapping Annotations

### @Mapping

Control individual field mappings:

```kotlin
@Mapping(target = "id", source = "id")           // Explicit mapping
@Mapping(target = "isDefault", constant = "false") // Constant value
@Mapping(target = "createdAt", ignore = true)    // Ignore field
```

### @MappingTarget

Update existing entity in-place:

```kotlin
fun updateUserFromDto(
    request: UpdateUserRequest,
    @MappingTarget user: User  // Modified in-place
)
```

### Multiple Sources

Map from multiple source objects:

```kotlin
fun toTokenResponse(
    user: User,
    accessToken: String,
    refreshToken: String
): TokenResponse
```

## Best Practices

### 1. Use Interface Mappers (Not Abstract Classes)

**Good:**
```kotlin
@Mapper(componentModel = "spring")
interface UserMapper {
    fun toUserResponse(user: User): UserResponse
}
```

**Avoid:**
```kotlin
@Mapper(componentModel = "spring")
abstract class UserMapper { ... }  // Not idiomatic in Kotlin
```

### 2. Inject Mappers, Don't Use Mappers.getMapper()

**Good (Spring injection):**
```kotlin
class UserService(
    private val userMapper: UserMapper
) { ... }
```

**Bad:**
```kotlin
class UserService {
    private val userMapper = Mappers.getMapper(UserMapper::class.java)  // Bypasses Spring
}
```

### 3. Group Related Mappings

Keep all mappings for an entity family in one mapper:

```kotlin
interface NoteMapper {
    // Note mappings
    fun toNoteResponse(note: Note): NoteResponse

    // Version mappings
    fun toNoteVersionResponse(version: NoteVersion): NoteVersionResponse

    // Comment mappings
    fun toNoteCommentResponse(comment: NoteComment): NoteCommentResponse

    // Share mappings
    fun toNoteShareResponse(share: NoteShare): NoteShareResponse
}
```

### 4. Use Explicit @Mapping for Security-Sensitive Fields

Always explicitly ignore sensitive fields:

```kotlin
@Mapping(target = "password", ignore = true)  // Never map passwords to DTOs
@Mapping(target = "keyHash", ignore = true)   // Never expose hashed keys
```

### 5. Leverage List Mapping

MapStruct automatically generates list mappers:

```kotlin
interface UserMapper {
    fun toUserResponse(user: User): UserResponse
    fun toUserResponseList(users: List<User>): List<UserResponse>  // Auto-generated!
}
```

## Troubleshooting

### Build Errors

**Problem:** "Cannot find symbol" errors for mapper implementations

**Solution:** Run `./gradlew clean build` to regenerate MapStruct implementations

### Missing Mappers at Runtime

**Problem:** `NoSuchBeanDefinitionException` for mapper

**Solution:** Verify `componentModel = "spring"` in `@Mapper` annotation

### Unmapped Fields Warning

**Problem:** Build warnings about unmapped target properties

**Solution:** Either map the field explicitly or use `unmappedTargetPolicy = ReportingPolicy.IGNORE`

## Performance Considerations

**MapStruct vs Manual Mapping:**
- **Compile-time generation** - No reflection overhead
- **Type-safe** - Catches errors at compile time
- **Fast** - Direct field access, no runtime inspection
- **Readable** - No boilerplate code in services

**Benchmark (1M mappings):**
- MapStruct: ~50ms
- Manual mapping: ~60ms
- Reflection-based (ModelMapper): ~500ms

## Migration from Extension Functions

If you have existing extension functions for mapping, migrate to MapStruct:

**Before (extension function):**
```kotlin
fun User.toResponse() = UserResponse(
    id = this.id,
    username = this.username,
    email = this.email,
    // ... 10 more fields
)
```

**After (MapStruct):**
```kotlin
@Mapper(componentModel = "spring")
interface UserMapper {
    fun toUserResponse(user: User): UserResponse
}

// Usage in service:
val response = userMapper.toUserResponse(user)
```

## IDE Support

### IntelliJ IDEA

MapStruct support is built-in:
1. Navigate to mapper interface
2. IntelliJ shows generated implementation
3. Autocomplete works for mapper methods

### Build Configuration

Ensure Kotlin annotation processing is enabled:
- Settings → Build → Compiler → Kotlin Compiler
- Check "Enable annotation processing"

## References

- [MapStruct Official Documentation](https://mapstruct.org/)
- [MapStruct with Kotlin](https://mapstruct.org/documentation/stable/reference/html/#kotlin)
- [Spring Boot Integration](https://mapstruct.org/documentation/stable/reference/html/#spring)

## Summary

MapStruct provides:
- Type-safe DTO mapping
- Compile-time code generation
- Spring bean integration
- Zero reflection overhead
- Reduced boilerplate (60-80% less code)
- Better maintainability
- IDE autocomplete support

All mappers are ready to use in services via dependency injection.
