# Kotlin Backend Dockerfile
# Single-stage build using pre-built JAR from CI/CD

FROM eclipse-temurin:21-jre-jammy

# Install curl, docker-cli, iproute2 (ss command), and other utilities
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg iproute2 && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli

# Create app user and add to docker group (GID 988 matches host Docker socket).
#
# UID/GID 1000 must match scrapalot-chat and scrapalot-workers (see
# ../scrapalot-chat/docker-scrapalot/Dockerfile + entrypoint.sh). All
# three containers share the `scrapalot_data` volume mounted at
# /app/data; their entrypoints each chown /app/data/upload subtrees to
# their own runtime UID. If the backend ran as a different UID (we used
# to use the -r system-user slot ~999), whichever sibling restarted
# last would clobber the backend's chown and the very next note image
# upload would fail with 400 "Image upload directory is not writable".
# Bug seen 2026-05-23 after a workers redeploy at 11:14 stomped a
# 09:20 backend chown; aligning on UID 1000 removes the race entirely.
RUN groupadd -g 1000 scrapalot && useradd -u 1000 -g scrapalot -m -s /bin/bash scrapalot && \
    groupadd -f -g 988 docker && \
    usermod -aG docker scrapalot

WORKDIR /app

# Create logs, data and upload directories before copying JAR (cached layer).
# /app/data/upload is the target of the shared scrapalot_data volume — we pre-
# create notes/images and profile_pictures so that when the volume is first
# mounted the scrapalot user owns its subtree and Files.copy() from
# NoteController.saveNoteImage() doesn't fail with NoSuchFileException.
RUN mkdir -p /app/logs /app/data/logs /app/data/upload/notes/images /app/data/upload/profile_pictures \
    && chown -R scrapalot:scrapalot /app

# Copy pre-built JAR from CI/CD build (only this layer invalidates on code changes)
COPY --chown=scrapalot:scrapalot build/libs/*.jar app.jar

# Entrypoint script — runs as root, normalises owner on the upload
# subtrees the JVM needs to write to (the persistent volume mounts
# AFTER the image layers, so the Dockerfile mkdir/chown above is
# overlaid by whatever's already on disk), then drops to scrapalot
# via runuser before exec'ing the JVM.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# NOTE: NO `USER scrapalot` directive here — the entrypoint starts as
# root for the chown step, then drops privileges with runuser before
# exec'ing Java. runuser is part of util-linux which ships with the
# eclipse-temurin:21-jre-jammy base image.

# Expose ports
EXPOSE 8091 9090

# Java options for optimal performance
ENV JAVA_OPTS="-Xms512m -Xmx2048m \
    -XX:+UseG1GC \
    -XX:MaxGCPauseMillis=200 \
    -XX:+HeapDumpOnOutOfMemoryError \
    -XX:HeapDumpPath=/app/logs \
    --add-modules jdk.incubator.vector"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8091/actuator/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
