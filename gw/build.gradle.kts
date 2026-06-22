import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import com.google.protobuf.gradle.id

plugins {
    id("org.springframework.boot") version "3.4.1"
    id("io.spring.dependency-management") version "1.1.7"
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.spring") version "2.1.0"
    id("com.google.protobuf") version "0.9.4"
}

group = "com.scrapalot"
version = "1.0.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    mavenCentral()
}

extra["springCloudVersion"] = "2024.0.3"

dependencies {
    // Spring Cloud Gateway
    implementation("org.springframework.cloud:spring-cloud-starter-gateway")

    // Spring Security
    implementation("org.springframework.boot:spring-boot-starter-security")

    // WebFlux (required for reactive gateway)
    implementation("org.springframework.boot:spring-boot-starter-webflux")

    // Redis for rate limiting and session affinity
    implementation("org.springframework.boot:spring-boot-starter-data-redis-reactive")

    // Resilience4j for circuit breakers
    implementation("org.springframework.cloud:spring-cloud-starter-circuitbreaker-reactor-resilience4j")

    // JWT support
    implementation("io.jsonwebtoken:jjwt-api:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.12.6")

    // gRPC client (for calling backend services)
    implementation("io.grpc:grpc-netty:1.70.0")
    implementation("io.grpc:grpc-protobuf:1.70.0")
    implementation("io.grpc:grpc-stub:1.70.0")
    implementation("io.grpc:grpc-kotlin-stub:1.4.1")
    implementation("com.google.protobuf:protobuf-kotlin:4.29.2")
    implementation("com.google.protobuf:protobuf-java:4.29.2")

    // Micrometer for distributed tracing
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-tracing-bridge-brave")
    implementation("io.zipkin.reporter2:zipkin-reporter-brave")

    // Springdoc OpenAPI (Swagger UI)
    implementation("org.springdoc:springdoc-openapi-starter-webflux-ui:2.7.0")

    // Kotlin support
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("io.projectreactor.kotlin:reactor-kotlin-extensions")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-reactor")

    // Development tools
    developmentOnly("org.springframework.boot:spring-boot-devtools")

    // Testing
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("io.projectreactor:reactor-test")
    testImplementation("io.mockk:mockk:1.13.14")
}

dependencyManagement {
    imports {
        mavenBom("org.springframework.cloud:spring-cloud-dependencies:${property("springCloudVersion")}")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        freeCompilerArgs.addAll(
            "-Xjsr305=strict",
            "-Xcontext-receivers",
            "-java-parameters"
        )
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}

// Protobuf configuration for gRPC
protobuf {
    protoc {
        artifact = "com.google.protobuf:protoc:4.29.2"
    }
    plugins {
        id("grpc") {
            artifact = "io.grpc:protoc-gen-grpc-java:1.70.0"
        }
        id("grpckt") {
            artifact = "io.grpc:protoc-gen-grpc-kotlin:1.4.1:jdk8@jar"
        }
    }
    generateProtoTasks {
        all().forEach {
            it.plugins {
                id("grpc")
                id("grpckt")
            }
            it.builtins {
                id("kotlin")
            }
        }
    }
}

// Add generated sources to source sets
sourceSets {
    main {
        java {
            srcDir("build/generated/source/proto/main/grpc")
            srcDir("build/generated/source/proto/main/grpckt")
            srcDir("build/generated/source/proto/main/kotlin")
        }
    }
}
