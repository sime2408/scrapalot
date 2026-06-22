#!/bin/sh
# scrapalot-backend container entrypoint.
#
# Why this exists: /app/data is a persistent Docker volume mounted at
# runtime, shared with scrapalot-chat and scrapalot-workers. Each of
# those sibling containers chowns /app/data/upload to its own runtime
# UID on every start. If our UID disagrees, whichever container
# restarts last wins, and the next note image upload here surfaces as
# the "directory not writable" 400 (NoteController.kt:543).
#
# The Dockerfile creates the scrapalot user at UID/GID 1000 — the same
# UID that scrapalot-chat / scrapalot-workers run as — so the chown
# loop below is now idempotent across sibling restarts rather than
# racing with them.
#
# Fix: start as root, normalise ownership on just the directories the
# Kotlin app needs to write to (cheap — small subtrees), then drop
# privileges via runuser before exec'ing the JVM.

set -e

# Directories the backend must be able to write to. Add new ones here
# rather than chown-ing the whole /app/data tree — that would also touch
# the workspace-uuid subdirs owned by other containers (Python AI etc.).
WRITABLE_DIRS="
/app/data/upload/notes/images
/app/data/upload/profile_pictures
/app/logs
/app/data/logs
"

for d in $WRITABLE_DIRS; do
    mkdir -p "$d"
    # Quiet — chown spits per-file lines on a fresh volume; we don't
    # need that in the logs.
    chown -R scrapalot:scrapalot "$d" 2>/dev/null || true
done

# Hand off to the non-root user. exec replaces this shell so Java
# inherits PID 1 and receives SIGTERM from `docker stop` cleanly.
exec runuser -u scrapalot -- sh -c 'exec java $JAVA_OPTS -jar /app/app.jar'
