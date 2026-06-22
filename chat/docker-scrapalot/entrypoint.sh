#!/usr/bin/env bash
# Drop-root entrypoint. The container's persistent /app/data volume is
# bind-mounted from the host, which means the image's build-time
# `chown -R 1000:1000 /app/data` only reaches paths that the image
# itself creates, never paths the host has already seeded. When the
# image uid was migrated from root → 1000, every pre-existing file in
# the bind mount kept its old ownership and the runtime started
# hitting EACCES the first time it tried to mkdir under /app/data/upload.
#
# Reconcile ownership at startup, then drop privileges to uid 1000.
# The cheap pre-check skips the chown walk when nothing is stale.
set -e

TARGET_UID=1000
TARGET_GID=1000

if [ "$(id -u)" = "0" ]; then
  if find /app/data \! -uid "${TARGET_UID}" -print -quit 2>/dev/null | grep -q .; then
    chown -R -h "${TARGET_UID}:${TARGET_GID}" /app/data 2>/dev/null || true
  fi
  # Belt-and-braces: even if the global `find` test above missed
  # something, force-normalise the small write-hot subtrees every boot.
  # Bug seen 2026-05-20: TimedRotatingFileHandler.doRollover() at
  # midnight created a root-owned `scrapalot.log` (process was running
  # as uid 1000 but the new file somehow inherited root ownership —
  # likely a one-time historical drift from a manual `docker exec` as
  # root). Every subsequent log call then raised PermissionError,
  # which broke the gRPC handlers and the UI saw 15s timeouts on
  # getModelProviders / sessions / jobs / WebSocket notes.
  # `chown` on these tiny subtrees costs <50 ms cold and guarantees
  # the app can always rotate logs and write uploads.
  for d in /app/data/logs /app/data/upload /app/data/tmp /app/data/cache; do
    mkdir -p "$d"
    chown -R "${TARGET_UID}:${TARGET_GID}" "$d" 2>/dev/null || true
  done
  exec setpriv --reuid="${TARGET_UID}" --regid="${TARGET_GID}" --init-groups -- "$@"
fi

exec "$@"
