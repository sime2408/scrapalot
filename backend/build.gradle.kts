import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("org.springframework.boot") version "3.4.1"
    id("io.spring.dependency-management") version "1.1.7"
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.spring") version "2.1.0"
    kotlin("plugin.jpa") version "2.1.0"
    kotlin("kapt") version "2.1.0"
    id("com.google.protobuf") version "0.9.4"
    id("org.jlleitschuh.gradle.ktlint") version "12.1.2"
}

ktlint {
    // Plugin default ktlint clashes with Kotlin 2.1 on the buildscript classpath
    // (KtTokens.HEADER_KEYWORD error) — pin a Kotlin-2.x-compatible engine.
    version.set("1.5.0")
    android.set(false)
    filter {
        // Generated gRPC/protobuf sources are not ours to lint.
        exclude { it.file.path.contains("generated") }
    }
}

group = "com.scrapalot"
version = "1.0.0"

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

repositories {
    mavenCentral()
    maven { url = uri("https://repo.spring.io/milestone") }
}

dependencyManagement {
    imports {
        mavenBom("org.springframework.ai:spring-ai-bom:1.0.0")
    }
}

// Force core gRPC versions to be compatible with grpc-server-spring-boot-starter
// Note: grpc-kotlin-stub has its own versioning scheme (1.4.x)
configurations.all {
    resolutionStrategy.eachDependency {
        if (requested.group == "io.grpc" && !requested.name.contains("kotlin")) {
            useVersion("1.62.2")
        }
    }
}

dependencies {
    // Spring Boot Starters
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-webflux") // For reactive HTTP client (proxy to Python)
    implementation("org.springframework.boot:spring-boot-starter-mail")

    // Kotlin Support
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("org.jetbrains.kotlin:kotlin-stdlib")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("com.fasterxml.jackson.dataformat:jackson-dataformat-yaml")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-reactor")

    // Database
    runtimeOnly("org.postgresql:postgresql")
    implementation("org.liquibase:liquibase-core:4.30.0")
    implementation("io.hypersistence:hypersistence-utils-hibernate-63:3.9.0") // For JSONB support

    // JWT Authentication
    implementation("io.jsonwebtoken:jjwt-api:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.12.6")

    // Google OAuth
    implementation("com.google.api-client:google-api-client:2.7.0")
    implementation("com.google.oauth-client:google-oauth-client-jetty:1.36.0")
    implementation("com.google.http-client:google-http-client-jackson2:1.45.1")

    // MapStruct for DTO mapping
    implementation("org.mapstruct:mapstruct:1.6.3")
    kapt("org.mapstruct:mapstruct-processor:1.6.3")

    // Password encoding (BCrypt)
    implementation("org.springframework.security:spring-security-crypto")

    // Validation
    implementation("jakarta.validation:jakarta.validation-api")

    // Logging
    implementation("io.github.microutils:kotlin-logging-jvm:3.0.5")

    // API Documentation (Swagger/OpenAPI)
    // Using WebFlux version because backend has both Web and WebFlux starters
    implementation("org.springdoc:springdoc-openapi-starter-webflux-ui:2.7.0")

    // gRPC Server (for communication with Python FastAPI and API Gateway)
    // Using grpc 1.62.2 which is compatible with grpc-server-spring-boot-starter 3.1.0
    implementation("net.devh:grpc-server-spring-boot-starter:3.1.0.RELEASE")

    // gRPC Client (for calling Python CHAT service)
    implementation("net.devh:grpc-client-spring-boot-starter:3.1.0.RELEASE")

    // gRPC Core dependencies (shared by server and client)
    implementation("io.grpc:grpc-kotlin-stub:1.4.1")
    implementation("io.grpc:grpc-protobuf:1.62.2")
    implementation("io.grpc:grpc-stub:1.62.2")
    implementation("io.grpc:grpc-netty-shaded:1.62.2")
    implementation("com.google.protobuf:protobuf-kotlin:3.25.3")

    // Stripe Payment Integration
    implementation("com.stripe:stripe-java:28.2.0")

    // Spring AI (programmatic usage, no auto-configuration)
    implementation("org.springframework.ai:spring-ai-openai")

    // Redis for event-driven communication
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    implementation("io.lettuce:lettuce-core")

    // JSON for Redis message serialization
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")

    // Development Tools
    developmentOnly("org.springframework.boot:spring-boot-devtools")

    // Testing
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("io.mockk:mockk:1.13.14")
    testImplementation("com.ninja-squad:springmockk:4.0.2")
    testImplementation("org.testcontainers:testcontainers:1.20.4")
    testImplementation("org.testcontainers:postgresql:1.20.4")
    testImplementation("org.testcontainers:junit-jupiter:1.20.4")
}

// Kotlin Compiler Options
tasks.withType<KotlinCompile> {
    compilerOptions {
        freeCompilerArgs.addAll(
            "-Xjsr305=strict",
            "-Xcontext-receivers" // Enable Kotlin 2.0 context receivers
        )
        jvmTarget.set(JvmTarget.JVM_21)
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}

// Enable Spring Boot layered JAR for optimized Docker builds
tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    layered {
        enabled = true
    }
}

// Configure Kapt for MapStruct and Lombok
kapt {
    correctErrorTypes = true
    arguments {
        arg("mapstruct.defaultComponentModel", "spring")
        arg("mapstruct.unmappedTargetPolicy", "IGNORE")
    }
}

// Configure Protobuf for gRPC
protobuf {
    protoc {
        artifact = "com.google.protobuf:protoc:3.25.3"
    }
    plugins {
        create("grpc") {
            artifact = "io.grpc:protoc-gen-grpc-java:1.62.2"
        }
        create("grpckt") {
            artifact = "io.grpc:protoc-gen-grpc-kotlin:1.4.1:jdk8@jar"
        }
    }
    generateProtoTasks {
        all().forEach { task ->
            task.plugins {
                create("grpc")
                create("grpckt")
            }
            task.builtins {
                create("kotlin")
            }
        }
    }
}

// Add generated sources to source sets
sourceSets {
    main {
        java {
            srcDirs("build/generated/source/proto/main/grpc")
            srcDirs("build/generated/source/proto/main/grpckt")
            srcDirs("build/generated/source/proto/main/java")
            srcDirs("build/generated/source/proto/main/kotlin")
        }
    }
}
