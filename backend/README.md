# Scrapalot Backend - Spring Boot + Kotlin

Modern web application backend for Scrapalot, built with Spring Boot 3.2.5 and Kotlin 1.9.24.

[![Discord](https://img.shields.io/badge/Discord-Join%20our%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mmuCqzFXs7)

> 💬 **Join the community** — questions, self-hosting help, and roadmap discussion live on our [Discord server](https://discord.gg/mmuCqzFXs7).

## Overview

This Spring Boot service handles all "classical web application" concerns extracted from the Python FastAPI `scrapalot-chat` project:

- **Authentication & Authorization**: Google OAuth, JWT tokens, API keys
- **User Management**: Registration, login, profiles, password management
- **Workspace Management**: CRUD, sharing, team collaboration
- **Collection Management**: Document organization
- **Document Metadata**: File serving, listing, permissions
- **Notes Collaboration**: TipTap-based notes with versioning, sharing, comments
- **Settings Management**: User and server settings
- **gRPC Server**: Communication with Python FastAPI (port 9090)
- **Redis Pub/Sub**: Event-driven communication between services

The Python `scrapalot-chat` service remains focused on:
- RAG strategies and orchestration
- LLM integration and chat streaming
- Document processing (chunking, embeddings)
- Vector search and retrieval

**Service Communication**:
- **UI → Spring Boot**: REST API (port 8091)
- **Python → Spring Boot**: gRPC (port 9090)
- **Bidirectional**: Redis Pub/Sub (port 6379)

## Technology Stack

- **Spring Boot**: 3.2.5
- **Kotlin**: 1.9.24
- **Java**: 17
- **Database**: PostgreSQL 18
- **Build Tool**: Gradle (Kotlin DSL)
- **ORM**: Spring Data JPA / Hibernate
- **Security**: Spring Security + JWT
- **OAuth**: Google OAuth 2.0
- **DTO Mapping**: MapStruct 1.5.5
- **gRPC**: Spring Boot gRPC Server 3.1.0
- **Redis**: Spring Data Redis + Lettuce
- **WebSocket**: STOMP over SockJS
- **Testing**: JUnit 5, MockK, Testcontainers

## Prerequisites

- **Java 17** or higher
- **PostgreSQL 18** (via Docker or local)
- **Redis** (for event-driven communication with Python)
- **Gradle** (via wrapper - no installation needed)

## Project Structure

```
scrapalot-backend/
├── build.gradle.kts                 # Gradle build configuration
├── settings.gradle.kts              # Gradle settings
├── gradle.properties                # Gradle properties
├── gradlew                          # Gradle wrapper (Unix)
├── gradlew.bat                      # Gradle wrapper (Windows)
├── src/
│   ├── main/
│   │   ├── kotlin/
│   │   │   └── com/scrapalot/backend/
│   │   │       ├── ScrapalotBackendApplication.kt
│   │   │       ├── config/          # Configuration classes
│   │   │       ├── domain/          # JPA entities
│   │   │       ├── repository/      # Spring Data repositories
│   │   │       ├── service/         # Business logic
│   │   │       ├── controller/      # REST controllers
│   │   │       ├── dto/             # Data Transfer Objects
│   │   │       ├── mapper/          # MapStruct mappers
│   │   │       ├── security/        # Security components
│   │   │       ├── exception/       # Exception handling
│   │   │       └── util/            # Utilities
│   │   └── resources/
│   │       ├── application.yml      # Main configuration
│   │       ├── application-dev.yml  # Dev configuration
│   │       └── application-prod.yml # Prod configuration
│   └── test/
│       └── kotlin/                  # Test files
└── README.md
```

## Getting Started

### 1. Start PostgreSQL Database

Using Docker Compose (from workspace root):

```bash
cd docker-scrapalot
docker-compose up -d postgres-backend
```

### 2. Build the Project

```bash
./gradlew build
```

### 3. Run the Application

Development mode:
```bash
./gradlew bootRun --args='--spring.profiles.active=dev'
```

Or run the JAR:
```bash
java -jar build/libs/scrapalot-backend-0.0.1-SNAPSHOT.jar --spring.profiles.active=dev
```

### 4. Access the Application

- **API Base URL**: `http://localhost:8091/api/v1`
- **Health Check**: `http://localhost:8091/api/v1/actuator/health`

## Configuration

### Environment Variables

Create a `.env` file or set these environment variables:

```bash
# Database
DATABASE_URL=jdbc:postgresql://localhost:5432/scrapalot_backend
DATABASE_USER=scrapalot
DATABASE_PASSWORD=scrapalot123

# JWT
JWT_SECRET=your-secret-key-change-in-production-min-256-bits

# Google OAuth
GOOGLE_OAUTH_CLIENT_ID=your-google-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-google-client-secret

# File Upload
UPLOAD_PATH=data/upload
```

### Database Configuration

The application connects to PostgreSQL on port **5432** (pgvector Docker container).

Schema: `scrapalot`

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/register` - User registration
- `GET /api/v1/auth/google/callback` - Google OAuth callback
- `POST /api/v1/auth/api-keys` - Create API key

### Users
- `GET /api/v1/users/me` - Get current user
- `PUT /api/v1/users/me` - Update profile
- `GET /api/v1/users/search` - Search users

### Workspaces
- `GET /api/v1/workspaces` - List workspaces
- `POST /api/v1/workspaces` - Create workspace
- `POST /api/v1/workspaces/share` - Share workspace

### Collections
- `GET /api/v1/collections` - List collections
- `POST /api/v1/collections` - Create collection

### Documents
- `GET /api/v1/documents/collection/{id}` - List documents
- `GET /api/v1/documents/file/{id}` - Serve document file

### Notes
- `POST /api/v1/notes` - Create note
- `GET /api/v1/notes` - List notes
- `POST /api/v1/notes/{id}/share` - Share note

## Development

### Running Tests

```bash
./gradlew test
```

### Code Formatting

The project uses Kotlin's official code style.

### Building for Production

```bash
./gradlew clean build -x test
```

## Integration with Python Service

Both services share the same PostgreSQL database on the `scrapalot` schema.

### Communication Flow

**Frontend → Spring Boot** (Classical web app features):
```
React UI → Spring Boot → PostgreSQL
```

**Frontend → Python** (RAG & Chat):
```
React UI → FastAPI Python → PostgreSQL (metadata)
                         → Neo4j (graph)
                         → Vector Store
                         → LLMs
```

### Shared Database

Spring Boot and Python both connect to the same PostgreSQL instance but different databases:
- **Spring Boot**: `scrapalot_backend` (port 5432)
- **Python**: `scrapalot` (port 5432, same pgvector instance)

Both use the same schema: `scrapalot`

## Deployment

### Docker Build

```bash
docker build -t scrapalot-backend:latest .
```

### Production Checklist

- [ ] Set strong `JWT_SECRET` (min 256 bits)
- [ ] Configure production database credentials
- [ ] Enable HTTPS/TLS
- [ ] Configure CORS for production domains
- [ ] Set up monitoring and logging
- [ ] Configure backup strategy

## Troubleshooting

### Database Connection Issues

Check PostgreSQL is running:
```bash
docker ps | grep postgres
```

Test connection:
```bash
psql -h localhost -p 5432 -U scrapalot -d scrapalot_backend
```

### Port Conflicts

If port 8091 is in use, change in `application.yml`:
```yaml
server:
  port: 8092
```

## Contributing

1. Follow Kotlin coding conventions
2. Write tests for new features
3. Update documentation
4. Ensure all tests pass before committing

## License

Scrapalot is **open-core**. This repository is part of the **proprietary, hosted Scrapalot product** (Pro / Team / Enterprise) — © 2024–2026 Scrapalot, all rights reserved.

A free, self-hostable **Community Edition** is published separately under the **AGPL-3.0** license. See [Editions](https://docs.scrapalot.app/getting-started/editions) for what each includes.

## Support

For issues and questions, contact the Scrapalot development team.
# Test commit to trigger workflow
