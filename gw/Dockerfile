# Scrapalot API Gateway - Multi-stage Docker build
# Stage 1: Build the application
# Use jammy (Debian) instead of alpine for gRPC protoc compatibility
FROM gradle:8.12-jdk21-jammy AS builder

WORKDIR /app

# Copy Gradle wrapper and build files
COPY gradlew .
COPY gradle gradle
COPY build.gradle.kts .
COPY settings.gradle.kts .

# Download dependencies (cached layer)
RUN gradle dependencies --no-daemon || true

# Copy proto files (needed for gRPC code generation)
COPY src/main/proto src/main/proto

# Copy source code
COPY src src

# Build the application (skip tests for faster builds)
RUN gradle bootJar --no-daemon -x test

# Stage 2: Runtime image
FROM eclipse-temurin:21-jre-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Create non-root user
RUN addgroup -g 1000 scrapalot && \
    adduser -D -u 1000 -G scrapalot scrapalot

WORKDIR /app

# Copy JAR from builder
COPY --from=builder /app/build/libs/*.jar app.jar

# Change ownership
RUN chown -R scrapalot:scrapalot /app

# Switch to non-root user
USER scrapalot

# Environment variables with defaults
ENV JAVA_OPTS="-Xms256m -Xmx1024m -XX:+UseG1GC -XX:MaxGCPauseMillis=200" \
    SPRING_PROFILES_ACTIVE=prod \
    SERVER_PORT=8080 \
    TZ=UTC

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/actuator/health || exit 1

# Run the application
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
