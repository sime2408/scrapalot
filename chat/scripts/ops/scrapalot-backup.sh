#!/usr/bin/env bash
#
# Weekly FULL backup of Scrapalot state -> Cloudflare R2 (single copy, off-server).
#
# What is backed up (fixed keys on R2 -> each run OVERWRITES -> exactly ONE copy):
#   databases/scrapalot.dump            Postgres `scrapalot` (pg_dump -Fc -Z9, online)
#   databases/scrapalot_backend.dump    Postgres `scrapalot_backend` (online)
#   databases/pg-globals.sql            Postgres roles (pg_dumpall -g)
#   databases/neo4j.dump.gz             Neo4j graph (neo4j-admin dump, BRIEF downtime ~2-4 min)
#   databases/redis-data.tar.gz         Redis RDB+AOF (BGSAVE best-effort, then volume tar)
#   volumes/uploads.tar.gz              scrapalot_data volume WITHOUT models/logs/cache/tmp
#   volumes/npm_data.tar.gz             Nginx Proxy Manager config + proxy hosts (no logs)
#   volumes/npm_letsencrypt.tar.gz      Let's Encrypt certificates
#   volumes/portainer_data.tar.gz       Portainer settings
#   configs/server-configs.tar.gz       .env, configs/ (secrets.yaml!), compose, /etc bits,
#                                       crontab, ufw, dotfiles, rclone.conf, ssh pubkeys
#   configs/claude-code.tar.gz          ~/.claude settings + per-project memory,
#                                       ~/.claude.json, /opt/scrapalot/.claude, CLAUDE.md
#
# NOT backed up (by design):
#   - HF/GGUF models (re-downloadable), container logs, Docker images (rebuilt by CI)
#   - SSH PRIVATE keys and ~/.git-credentials (regenerate via GitHub on restore)
#   - Session transcripts / file-history under ~/.claude (ephemeral)
#
# Design: collect errors per section, upload everything that succeeded, exit 1 if
# anything failed. A Neo4j failure must never again block the Postgres upload
# (2026-06-07 incident: AccessDeniedException aborted the run pre-upload, R2 stayed empty).
#
# Canonical copy lives in git: scrapalot-chat/scripts/ops/scrapalot-backup.sh
# Deployed copy: /home/scrapalot/bin/scrapalot-backup.sh (cron: Sundays 04:00 UTC)
# Requires: rclone remote `r2` (~/.config/rclone/rclone.conf), docker group,
#           passwordless sudo (reading root-owned volume mountpoints), pigz.
#
# Restore runbook: scrapalot-chat/docs/README_BACKUP_RECOVERY.md
#
set -uo pipefail

TMP=/mnt/volume-nbg1-1/backups/tmp
R2_DEST=r2:scrapalot-backup
NEO4J_IMAGE=neo4j:2025-community
LOG=/mnt/volume-nbg1-1/backups/backup.log
STATUS_FILE=/mnt/volume-nbg1-1/backups/last_status
ENV_FILE=/opt/scrapalot/scrapalot-chat/docker-scrapalot/.env
CHAT_DIR=/opt/scrapalot/scrapalot-chat
MIN_FREE_GB=12
GZIP="pigz -6 -p4"   # parallel gzip, capped at 4 threads to keep the box responsive

FAILURES=()

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
sect_fail() { log "ERROR: $*"; FAILURES+=("$*"); }
die()  { log "FATAL: $*"; echo "FAILED $(date -u +%FT%TZ): $*" > "$STATUS_FILE"; exit 1; }

# tar exit 1 = "file changed as we read it" (live system, acceptable); >=2 = fatal
tar_live() { tar "$@"; local rc=$?; [ "$rc" -ge 2 ] && return "$rc"; return 0; }

# --- Preflight ---------------------------------------------------------------
command -v rclone >/dev/null || die "rclone not installed"
command -v pigz   >/dev/null || GZIP="gzip -6"
rclone lsd "$R2_DEST" >/dev/null 2>&1 \
  || die "R2 remote 'r2' not reachable — check ~/.config/rclone/rclone.conf credentials"

AVAIL_GB=$(df --output=avail -BG /mnt/volume-nbg1-1 | tail -1 | tr -dc '0-9')
[ "$AVAIL_GB" -ge "$MIN_FREE_GB" ] \
  || die "only ${AVAIL_GB}G free on /mnt/volume-nbg1-1 (need ${MIN_FREE_GB}G staging space)"

mkdir -p "$TMP"/{databases,volumes,configs}
rm -rf "$TMP"/stage
# remove stale flat-layout dumps from the pre-2026-06 script so they don't upload to wrong keys
rm -f "$TMP"/*.dump "$TMP"/*.dump.gz
log "=== Backup start -> $R2_DEST (single copy, ${AVAIL_GB}G free) ==="

# --- 1. Postgres (online, no downtime) --------------------------------------
for DB in scrapalot scrapalot_backend; do
  log "pg_dump $DB"
  if docker exec pgvector pg_dump -U scrapalot -Fc -Z9 "$DB" > "$TMP/databases/${DB}.dump" 2>>"$LOG"; then
    log "  ok: $(du -h "$TMP/databases/${DB}.dump" | cut -f1)"
  else
    rm -f "$TMP/databases/${DB}.dump"
    sect_fail "pg_dump $DB failed"
  fi
done
docker exec pgvector pg_dumpall -U scrapalot -g > "$TMP/databases/pg-globals.sql" 2>>"$LOG" \
  || sect_fail "pg_dumpall --globals-only failed"

# --- 2. Volume tar helper -----------------------------------------------------
backup_volume() {  # <volume-name> <out-file> [tar excludes...]
  local VOL="$1" OUT="$2"; shift 2
  local MP RC_TAR RC_GZ RCS
  MP=$(docker volume inspect -f '{{.Mountpoint}}' "$VOL" 2>/dev/null)
  if [ -z "$MP" ]; then sect_fail "volume $VOL not found"; return; fi
  log "tar $VOL -> $(basename "$OUT")"
  sudo -n tar cf - "$@" -C "$MP" . 2>>"$LOG" | $GZIP > "$OUT"
  RCS=("${PIPESTATUS[@]}")   # capture in ONE expansion — any later command resets PIPESTATUS
  RC_TAR=${RCS[0]}; RC_GZ=${RCS[1]:-1}
  # GNU tar exit 1 = "file changed as we read it" (live system) -> archive is usable
  if [ "$RC_GZ" -eq 0 ] && [ "$RC_TAR" -le 1 ]; then
    log "  ok: $(du -h "$OUT" | cut -f1)"
  else
    rm -f "$OUT"
    sect_fail "tar $VOL failed (tar=$RC_TAR gzip=$RC_GZ)"
  fi
}

# --- 3. Redis (BGSAVE best-effort, then tar the volume: RDB + AOF) ----------
log "Redis snapshot"
REDIS_PASSWORD=$(grep -E '^REDIS_PASSWORD=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
if [ -n "${REDIS_PASSWORD}" ]; then
  LAST=$(docker exec redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" LASTSAVE 2>/dev/null)
  if [ -n "$LAST" ]; then
    docker exec redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" BGSAVE >/dev/null 2>&1
    for _ in $(seq 1 30); do
      sleep 2
      NOW=$(docker exec redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" LASTSAVE 2>/dev/null)
      [ -n "$NOW" ] && [ "$NOW" != "$LAST" ] && break
    done
  else
    log "  WARNING: redis LASTSAVE failed (auth?) — taring volume without fresh BGSAVE"
  fi
fi
backup_volume docker-scrapalot_redis_data "$TMP/databases/redis-data.tar.gz"

# --- 4. Docker volumes: uploads, NPM, letsencrypt, portainer ----------------

backup_volume docker-scrapalot_scrapalot_data "$TMP/volumes/uploads.tar.gz" \
  --exclude='./models' --exclude='./logs' --exclude='./cache' --exclude='./tmp' --exclude='./*.log'
backup_volume docker-scrapalot_npm_data        "$TMP/volumes/npm_data.tar.gz" --exclude='./logs' --exclude='./downloads'
backup_volume docker-scrapalot_npm_letsencrypt "$TMP/volumes/npm_letsencrypt.tar.gz"
backup_volume docker-scrapalot_portainer_data  "$TMP/volumes/portainer_data.tar.gz"

# --- 5. Server configs bundle ------------------------------------------------
log "Bundling server configs"
STAGE="$TMP/stage/server-configs"
mkdir -p "$STAGE"/{etc,home/ssh,home/bin}
cp -a "$CHAT_DIR/docker-scrapalot" "$STAGE/docker-scrapalot" 2>>"$LOG"   # includes .env
cp -a "$CHAT_DIR/configs"          "$STAGE/configs"          2>>"$LOG"   # includes secrets.yaml
sudo -n cp -a /etc/docker/daemon.json /etc/fstab "$STAGE/etc/" 2>>"$LOG"
sudo -n cp -a /etc/cron.d/scrapalot-pg-backup /usr/local/sbin/scrapalot-pg-backup.sh "$STAGE/etc/" 2>>"$LOG"
sudo -n sh -c "cp -a /etc/sudoers.d/scrapalot* /etc/systemd/system/actions.runner.* '$STAGE/etc/'" 2>>"$LOG"
crontab -l > "$STAGE/crontab-scrapalot.txt" 2>/dev/null
sudo -n ufw status verbose > "$STAGE/ufw-status.txt" 2>/dev/null
{ docker ps -a; echo; docker volume ls; } > "$STAGE/docker-state.txt" 2>/dev/null
cp -a ~/.bashrc ~/.profile ~/.gitconfig "$STAGE/home/" 2>>"$LOG"
cp -a ~/.config/rclone/rclone.conf "$STAGE/home/rclone.conf" 2>>"$LOG"
cp -a ~/.ssh/config ~/.ssh/known_hosts ~/.ssh/*.pub "$STAGE/home/ssh/" 2>/dev/null  # NO private keys
cp -a ~/bin/. "$STAGE/home/bin/" 2>/dev/null
sudo -n chown -R "$(id -u):$(id -g)" "$STAGE" 2>>"$LOG"
if tar_live czf "$TMP/configs/server-configs.tar.gz" -C "$STAGE" .; then
  log "  ok: $(du -h "$TMP/configs/server-configs.tar.gz" | cut -f1)"
else
  sect_fail "server-configs bundle failed"
fi

# --- 6. Claude Code settings + memory bundle ---------------------------------
log "Bundling Claude Code settings + memory"
CSTAGE="$TMP/stage/claude-code"
mkdir -p "$CSTAGE"/{home-claude/plugins,home-claude/projects,opt-scrapalot}
for f in settings.json settings.local.json CLAUDE.md statusline-command.sh history.jsonl; do
  cp -a ~/.claude/"$f" "$CSTAGE/home-claude/" 2>/dev/null
done
cp -a ~/.claude/commands ~/.claude/plans "$CSTAGE/home-claude/" 2>/dev/null
for f in config.json installed_plugins.json known_marketplaces.json blocklist.json; do
  cp -a ~/.claude/plugins/"$f" "$CSTAGE/home-claude/plugins/" 2>/dev/null
done
for p in ~/.claude/projects/*/; do   # per-project MEMORY only — transcripts are ephemeral
  [ -d "$p/memory" ] || continue
  mkdir -p "$CSTAGE/home-claude/projects/$(basename "$p")"
  cp -a "$p/memory" "$CSTAGE/home-claude/projects/$(basename "$p")/"
done
cp -a ~/.claude.json "$CSTAGE/home-claude/claude.json" 2>/dev/null
cp -a /opt/scrapalot/.claude "$CSTAGE/opt-scrapalot/" 2>>"$LOG"
cp -a /opt/scrapalot/CLAUDE.md "$CSTAGE/opt-scrapalot/" 2>>"$LOG"
if tar_live czf "$TMP/configs/claude-code.tar.gz" -C "$CSTAGE" .; then
  log "  ok: $(du -h "$TMP/configs/claude-code.tar.gz" | cut -f1)"
else
  sect_fail "claude-code bundle failed"
fi
rm -rf "$TMP/stage"

# --- 7. Neo4j (Community -> offline dump; brief stop/start). LAST so its ----
# ---    failure can never block the sections above from reaching R2. --------
log "Stopping neo4j for consistent dump..."
NEO_DIR="$TMP/databases/neo4j-dump"
mkdir -p "$NEO_DIR" && chmod 777 "$NEO_DIR"   # neo4j-admin runs as uid 7474 inside the container
if docker stop neo4j >>"$LOG" 2>&1; then
  if docker run --rm --volumes-from neo4j -v "$NEO_DIR":/backups "$NEO4J_IMAGE" \
        neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination >>"$LOG" 2>&1; then
    docker start neo4j >>"$LOG" 2>&1 || sect_fail "docker start neo4j FAILED — CHECK MANUALLY"
    sudo -n chown -R "$(id -u):$(id -g)" "$NEO_DIR" 2>>"$LOG"
    if [ -f "$NEO_DIR/neo4j.dump" ]; then
      $GZIP -f "$NEO_DIR/neo4j.dump" \
        && mv -f "$NEO_DIR/neo4j.dump.gz" "$TMP/databases/neo4j.dump.gz" \
        && log "  neo4j ok: $(du -h "$TMP/databases/neo4j.dump.gz" | cut -f1)"
    else
      sect_fail "neo4j dump file missing after successful dump command"
    fi
  else
    docker start neo4j >>"$LOG" 2>&1 || log "WARNING: docker start neo4j FAILED — CHECK MANUALLY"
    sect_fail "neo4j-admin dump failed (neo4j restarted)"
  fi
  # wait until healthy again so the next cron section never races a down graph
  for _ in $(seq 1 24); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' neo4j 2>/dev/null)" = "healthy" ] && break
    sleep 5
  done
  log "neo4j state: $(docker inspect -f '{{.State.Health.Status}}' neo4j 2>/dev/null)"
else
  sect_fail "docker stop neo4j failed — skipping graph dump"
fi
rm -rf "$NEO_DIR"

# --- 8. Upload to R2 (fixed keys = overwrite = single copy) ------------------
log "Uploading to $R2_DEST ..."
if rclone copy "$TMP" "$R2_DEST" --s3-no-check-bucket --transfers 4 \
     --exclude "stage/**" --log-file="$LOG" --log-level INFO; then
  log "Upload finished."
else
  die "rclone upload failed — KEEPING local dumps in $TMP for manual upload"
fi

# --- 9. Verify upload, then delete local (nothing stays on server) -----------
# verify every file this run actually produced (so a successful neo4j dump is
# checked too, while a failed/absent section doesn't false-flag the verify)
MISSING=""
while IFS= read -r -d '' F; do
  KEY="${F#"$TMP"/}"
  rclone lsf "$R2_DEST/$(dirname "$KEY")" 2>/dev/null | grep -q "^$(basename "$KEY")$" || MISSING="$MISSING $KEY"
done < <(find "$TMP" -mindepth 2 -maxdepth 2 -type f -print0)
if [ -z "$MISSING" ]; then
  log "R2 now holds: $(rclone size "$R2_DEST" --json 2>/dev/null)"
  rm -rf "$TMP"/databases "$TMP"/volumes "$TMP"/configs
  log "Local temp cleared; single copy lives on R2."
else
  FAILURES+=("upload verification failed for:$MISSING (local files kept in $TMP)")
fi

# --- 10. Final status ---------------------------------------------------------
if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "OK $(date -u +%FT%TZ)" > "$STATUS_FILE"
  log "=== Done. All sections OK. ==="
  exit 0
else
  printf 'FAILED %s: %s\n' "$(date -u +%FT%TZ)" "${FAILURES[*]}" > "$STATUS_FILE"
  log "=== Done WITH ERRORS (${#FAILURES[@]}): ${FAILURES[*]} ==="
  exit 1
fi
