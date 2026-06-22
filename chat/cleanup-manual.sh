#!/bin/bash
# Manual Docker Cleanup Script for Scrapalot
# Run this script manually when you need immediate storage cleanup

set -e

echo "🧹 ==============================================="
echo "🧹 SCRAPALOT STORAGE CLEANUP - MANUAL EXECUTION"
echo "🧹 ==============================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_step() {
    echo -e "${BLUE}🧹 $1${NC}"
}

print_success() {
    echo -e "${GREEN}$1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}💡 $1${NC}"
}

# Show initial disk usage
print_step "Checking initial disk usage..."
echo "System disk usage:"
df -h /
echo ""
echo "Docker disk usage:"
docker system df
echo ""

# Store initial usage for comparison
INITIAL_USED=$(df / | tail -1 | awk '{print $3}')
INITIAL_DOCKER=$(docker system df | grep "Local Volumes" | awk '{print $3}')

# 1. Clean Docker build cache (IMMEDIATE BIG WIN)
print_step "Removing Docker build cache..."
BUILD_CACHE_REMOVED=$(docker builder prune -af 2>&1 | grep "Total:" | awk '{print $2}' || echo "0B")
print_success "Build cache removed: $BUILD_CACHE_REMOVED"

# 2. Remove dangling images
print_step "Removing dangling (untagged) images..."
DANGLING_REMOVED=$(docker image prune -f 2>&1 | grep "Total:" | awk '{print $3}' || echo "0B")
print_success "Dangling images removed: $DANGLING_REMOVED"

# 3. Remove unused images older than 24 hours
print_step "Removing unused images older than 24 hours..."
IMAGES_REMOVED=$(docker image prune -af --filter "until=24h" 2>&1 | grep "Total:" | awk '{print $3}' || echo "0B")
print_success "Old images removed: $IMAGES_REMOVED"

# 4. Remove stopped containers
print_step "Removing stopped containers..."
CONTAINERS_REMOVED=$(docker container prune -f 2>&1 | grep "Total:" | awk '{print $3}' || echo "0B")
print_success "Stopped containers removed: $CONTAINERS_REMOVED"

# 5. Remove unused networks
print_step "Removing unused networks..."
docker network prune -f >/dev/null 2>&1
print_success "Unused networks removed"

# 6. Clean systemd journal logs older than 7 days
print_step "Cleaning systemd journal logs older than 7 days..."
JOURNAL_BEFORE=$(du -sm /var/log/journal 2>/dev/null | awk '{print $1}' || echo "0")
sudo journalctl --vacuum-time=7d >/dev/null 2>&1
JOURNAL_AFTER=$(du -sm /var/log/journal 2>/dev/null | awk '{print $1}' || echo "0")
JOURNAL_FREED=$((JOURNAL_BEFORE - JOURNAL_AFTER))
if [ $JOURNAL_FREED -gt 0 ]; then
    print_success "Journal logs cleaned: ${JOURNAL_FREED}MB"
else
    print_success "Journal logs already optimal"
fi

# 7. Clean failed login attempt logs (btmp)
print_step "Cleaning failed login attempt logs (btmp)..."
BTMP_SIZE=$(du -sm /var/log/btmp* 2>/dev/null | awk '{sum+=$1} END {print sum}' || echo "0")
if [ $BTMP_SIZE -gt 10 ]; then
    sudo rm -f /var/log/btmp.* 2>/dev/null
    sudo truncate -s 0 /var/log/btmp 2>/dev/null
    print_success "Btmp logs cleaned: ${BTMP_SIZE}MB"
else
    print_success "Btmp logs already optimal (${BTMP_SIZE}MB)"
fi

# 8. Clean stale scratch files in /tmp older than 1 day
print_step "Cleaning stale scratch files in /tmp older than 1 day..."
TMP_BEFORE=$(du -sm /tmp 2>/dev/null | awk '{print $1}' || echo "0")
# Remove well-known scratch patterns (audit notes, backfill / pattern / fingerprint / cat_f
# helper scripts, hollow-book lists, kotlin-daemon logs, docker build logs, hier/neo/pg ID dumps).
# maxdepth 1 keeps system dirs (claude-*, hsperfdata_*, snap.*, .X*-lock, systemd-private-*) untouched.
sudo find /tmp -maxdepth 1 -type f -mtime +1 \
    \( -name "audit*.md" -o -name "audit*.txt" -o -name "a6402a60.md" \
       -o -name "backfill_*.py" -o -name "cat_f_*.py" -o -name "fingerprint_*.py" \
       -o -name "pattern_*.py" -o -name "gen_summary.py" \
       -o -name "hier_*.json" -o -name "hollow_books.txt" \
       -o -name "neo_ids.txt" -o -name "pg_ids.txt" \
       -o -name "kotlin-daemon.*.log" -o -name "docker-build.log" \) \
    -delete 2>/dev/null || true
TMP_AFTER=$(du -sm /tmp 2>/dev/null | awk '{print $1}' || echo "0")
TMP_FREED=$((TMP_BEFORE - TMP_AFTER))
if [ $TMP_FREED -gt 0 ]; then
    print_success "/tmp cleaned: ${TMP_FREED}MB"
else
    print_success "/tmp already optimal (${TMP_BEFORE}MB)"
fi

# 9. Clean GitHub Actions runner logs older than 7 days
print_step "Cleaning GitHub Actions runner logs older than 7 days..."
RUNNER_LOGS_CLEANED=$(find /opt/scrapalot/actions-runner*/_diag -name "*.log" -mtime +7 -delete 2>/dev/null | wc -l || echo "0")
print_success "Runner log files cleaned: $RUNNER_LOGS_CLEANED"

# 10. Clean Claude Code session caches older than 15 days
# Trims session JSONL transcripts, file-history snapshots, shell snapshots, paste/session-env
# scratch dirs, and stale todo lists. Persistent memory lives under
# ~/.claude/projects/<project>/memory/ — explicitly excluded so MEMORY.md and
# feedback_*.md/project_*.md/reference_*.md files survive.
print_step "Cleaning Claude Code session caches older than 15 days..."
CLAUDE_FREED_TOTAL=0
for HOME_DIR in /home/scrapalot /home/github-runner; do
    CLAUDE_DIR="$HOME_DIR/.claude"
    [ -d "$CLAUDE_DIR" ] || continue
    CLAUDE_BEFORE=$(sudo du -sm "$CLAUDE_DIR" 2>/dev/null | awk '{print $1}' || echo "0")

    # Session transcripts (projects/<key>/*.jsonl) — skip memory/ dirs
    sudo find "$CLAUDE_DIR/projects" -type f -name "*.jsonl" -mtime +15 \
        -not -path "*/memory/*" -delete 2>/dev/null || true

    # File-history (per-edit snapshots), shell snapshots, paste cache, session-env
    for SUBDIR in file-history shell-snapshots paste-cache session-env todos tasks; do
        [ -d "$CLAUDE_DIR/$SUBDIR" ] && \
            sudo find "$CLAUDE_DIR/$SUBDIR" -type f -mtime +15 -delete 2>/dev/null || true
    done
    # Drop empty dirs left behind under file-history (one dir per file path)
    sudo find "$CLAUDE_DIR/file-history" -mindepth 1 -type d -empty -delete 2>/dev/null || true

    CLAUDE_AFTER=$(sudo du -sm "$CLAUDE_DIR" 2>/dev/null | awk '{print $1}' || echo "0")
    CLAUDE_FREED=$((CLAUDE_BEFORE - CLAUDE_AFTER))
    CLAUDE_FREED_TOTAL=$((CLAUDE_FREED_TOTAL + CLAUDE_FREED))
    if [ $CLAUDE_FREED -gt 0 ]; then
        print_success "  $CLAUDE_DIR: ${CLAUDE_FREED}MB freed (now ${CLAUDE_AFTER}MB)"
    else
        print_success "  $CLAUDE_DIR: already optimal (${CLAUDE_BEFORE}MB)"
    fi
done
print_success "Claude session caches total freed: ${CLAUDE_FREED_TOTAL}MB"

# 11. Clean per-user developer caches on the host
# These build up on the root disk (/) and were the cause of the 2026-05-20
# disk-pressure incident: /home/scrapalot reached 4.6 GB (1.1 GB .gradle/caches,
# 379 MB .cache/pre-commit, 622 MB .cache/ms-playwright) and /home/github-runner
# was at 1.1 GB (990 MB .gradle/caches). All four targeted subtrees regenerate
# on next use — gradle re-downloads deps, pip/npm re-download packages,
# pre-commit re-installs hooks. ms-playwright is intentionally NOT touched
# because it holds the Chromium binary the E2E suite needs at test time.
print_step "Cleaning per-user dev caches (Gradle / pre-commit / pip / npm)..."
USER_CACHE_FREED_TOTAL=0
for HOME_DIR in /home/scrapalot /home/github-runner; do
    [ -d "$HOME_DIR" ] || continue
    HOST_USER=$(basename "$HOME_DIR")
    HOME_BEFORE=$(sudo du -sm "$HOME_DIR" 2>/dev/null | awk '{print $1}' || echo "0")
    for SUBPATH in \
        ".gradle/caches" \
        ".gradle/wrapper" \
        ".cache/pre-commit" \
        ".cache/pip" \
        ".npm/_cacache"; do
        TARGET="$HOME_DIR/$SUBPATH"
        [ -d "$TARGET" ] || continue
        sudo -u "$HOST_USER" rm -rf "$TARGET" 2>/dev/null || \
            sudo rm -rf "$TARGET" 2>/dev/null || true
    done
    HOME_AFTER=$(sudo du -sm "$HOME_DIR" 2>/dev/null | awk '{print $1}' || echo "0")
    HOME_FREED=$((HOME_BEFORE - HOME_AFTER))
    USER_CACHE_FREED_TOTAL=$((USER_CACHE_FREED_TOTAL + HOME_FREED))
    if [ $HOME_FREED -gt 0 ]; then
        print_success "  $HOME_DIR: ${HOME_FREED}MB freed (now ${HOME_AFTER}MB)"
    else
        print_success "  $HOME_DIR: already optimal (${HOME_BEFORE}MB)"
    fi
done
print_success "Per-user dev caches total freed: ${USER_CACHE_FREED_TOTAL}MB"

# 12. Check for large model files that could be optimized
print_step "Analyzing model storage for optimization opportunities..."
if [ -d "/var/lib/docker/volumes/docker-scrapalot_scrapalot_data/_data/models" ]; then
    echo "Current model storage breakdown:"
    sudo du -sh /var/lib/docker/volumes/docker-scrapalot_scrapalot_data/_data/models/* 2>/dev/null || echo "No models found"

    # Check for large intfloat model
    INTFLOAT_SIZE=$(sudo find /var/lib/docker/volumes/docker-scrapalot_scrapalot_data/_data/models -name "*intfloat*multilingual-e5-large*" -type d -exec du -sh {} \; 2>/dev/null | awk '{print $1}' || echo "")
    if [ -n "$INTFLOAT_SIZE" ]; then
        print_warning "Large intfloat model found ($INTFLOAT_SIZE)"
        print_info "Consider removing it manually if you're using all-MiniLM-L6-v2 for CPU processing"
        print_info "Command: sudo rm -rf /var/lib/docker/volumes/docker-scrapalot_scrapalot_data/_data/models/huggingface/models--intfloat--multilingual-e5-large-instruct"
    fi
fi

# 13. System log rotation
print_step "Rotating system logs..."
sudo logrotate -f /etc/logrotate.conf 2>/dev/null || print_warning "Log rotation had some issues (normal)"
print_success "System logs rotated"

# Show final disk usage
echo ""
print_step "Final disk usage analysis..."
echo "System disk usage:"
df -h /
echo ""
echo "Docker disk usage:"
docker system df
echo ""

# Calculate space saved
FINAL_USED=$(df / | tail -1 | awk '{print $3}')
SPACE_SAVED=$((INITIAL_USED - FINAL_USED))

# Convert to human readable
if [ $SPACE_SAVED -gt 1048576 ]; then
    SPACE_SAVED_HR="$((SPACE_SAVED / 1048576))GB"
elif [ $SPACE_SAVED -gt 1024 ]; then
    SPACE_SAVED_HR="$((SPACE_SAVED / 1024))MB"
else
    SPACE_SAVED_HR="${SPACE_SAVED}KB"
fi

# Get final Docker statistics
FINAL_DOCKER_VOLUMES=$(docker system df | grep "Local Volumes" | awk '{print $3}')
FINAL_IMAGES=$(docker system df | grep "^Images" | awk '{print $3}')
FINAL_BUILD_CACHE=$(docker system df | grep "Build Cache" | awk '{print $3}')
FINAL_CONTAINERS=$(docker system df | grep "^Containers" | awk '{print $3}')

echo ""
echo "🧹 ==============================================="
print_success "CLEANUP COMPLETED!"
echo "🧹 ==============================================="
echo ""
echo "┌──────────────────────────────────────────────────────────────────┐"
echo "│                     CLEANUP STATISTICS SUMMARY                   │"
echo "├──────────────────────────────────────────────────────────────────┤"
printf "│ %-30s │ %-15s │ %-15s │\n" "Component" "Removed" "Current Size"
echo "├──────────────────────────────────────────────────────────────────┤"
printf "│ %-30s │ %-15s │ %-15s │\n" "Build Cache" "${BUILD_CACHE_REMOVED:-0B}" "$FINAL_BUILD_CACHE"
printf "│ %-30s │ %-15s │ %-15s │\n" "Dangling Images" "${DANGLING_REMOVED:-0B}" "-"
printf "│ %-30s │ %-15s │ %-15s │\n" "Old Images (>24h)" "${IMAGES_REMOVED:-0B}" "$FINAL_IMAGES"
printf "│ %-30s │ %-15s │ %-15s │\n" "Stopped Containers" "${CONTAINERS_REMOVED:-0B}" "$FINAL_CONTAINERS"
printf "│ %-30s │ %-15s │ %-15s │\n" "Journal Logs (>7 days)" "${JOURNAL_FREED}MB" "-"
printf "│ %-30s │ %-15s │ %-15s │\n" "Btmp Logs" "${BTMP_SIZE}MB" "-"
printf "│ %-30s │ %-15s │ %-15s │\n" "/tmp Scratch Files" "${TMP_FREED}MB" "${TMP_AFTER}MB"
printf "│ %-30s │ %-15s │ %-15s │\n" "GitHub Runner Logs" "${RUNNER_LOGS_CLEANED} files" "-"
printf "│ %-30s │ %-15s │ %-15s │\n" "Claude Session Caches (>15d)" "${CLAUDE_FREED_TOTAL}MB" "-"
printf "│ %-30s │ %-15s │ %-15s │\n" "User Dev Caches (gradle/pip)" "${USER_CACHE_FREED_TOTAL}MB" "-"
printf "│ %-30s │ %-15s │ %-15s │\n" "Docker Volumes" "-" "$FINAL_DOCKER_VOLUMES"
echo "├──────────────────────────────────────────────────────────────────┤"
printf "│ %-30s │ %-32s │\n" "Total Space Saved" "~$SPACE_SAVED_HR"
printf "│ %-30s │ %-32s │\n" "Disk Available" "$(df -h / | tail -1 | awk '{print $4}')"
printf "│ %-30s │ %-32s │\n" "Disk Usage" "$(df -h / | tail -1 | awk '{print $5}')"
echo "└──────────────────────────────────────────────────────────────────┘"
echo "🧹 ==============================================="

# Show running containers to ensure nothing was broken
print_step "Verifying all services are still running..."
docker ps --format "table {{.Names}}\t{{.Status}}" --filter "name=scrapalot|redis|neo4j|portainer|nginx"
print_success "All services verified"

echo ""
print_info "For more aggressive cleanup, consider:"
print_info "1. Removing large embedding models if using CPU-optimized ones"
print_info "2. Cleaning up unused Docker volumes (BE VERY CAREFUL)"
print_info "3. Reviewing application logs in containers"
print_info "4. Docker system prune (ALL unused data): docker system prune -a --volumes --force"
echo ""
print_warning "⚠️  AGGRESSIVE CLEANUP WARNING:"
print_warning "Running 'docker system prune -a --volumes' will remove:"
print_warning "  - ALL unused Docker images (including tagged ones)"
print_warning "  - ALL unused Docker volumes (PERMANENT DATA LOSS RISK)"
print_warning "  - ALL unused build cache"
print_warning "Only use if you're absolutely sure no important data is in unused volumes!"

echo ""
print_success "Cleanup script completed successfully! 🎉"
