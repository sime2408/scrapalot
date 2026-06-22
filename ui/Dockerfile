# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Define build arguments for Vite environment variables
ARG VITE_API_BASE_URL
ARG VITE_LLM_INFERENCE_ENDPOINT
ARG VITE_APP_ENV=production
ARG VITE_ENABLE_DEBUG_LOGS=false
ARG VITE_ENABLE_PERFORMANCE_MONITORING=true

# Set environment variables from build args (Vite reads these during build)
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_LLM_INFERENCE_ENDPOINT=${VITE_LLM_INFERENCE_ENDPOINT}
ENV VITE_APP_ENV=${VITE_APP_ENV}
ENV VITE_ENABLE_DEBUG_LOGS=${VITE_ENABLE_DEBUG_LOGS}
ENV VITE_ENABLE_PERFORMANCE_MONITORING=${VITE_ENABLE_PERFORMANCE_MONITORING}

# OPTIMIZATION: Copy package files FIRST (better layer caching)
# This layer only invalidates when dependencies change
COPY package.json package-lock.json* ./

# CRITICAL: Copy patches/ BEFORE npm ci so patch-package can apply patches during postinstall
COPY patches ./patches

# OPTIMIZATION: Install dependencies with cache mount
# Cache persists between builds = MUCH faster npm ci
# postinstall script runs patch-package which needs patches/ folder
RUN --mount=type=cache,target=/root/.npm \
    npm ci && \
    echo "✓ Dependencies installed (cached)"

# Copy source code AFTER dependencies
# This way, code changes don't invalidate npm ci layer
COPY . .

# Debug: Print environment variables during build
RUN echo "=========================================" && \
    echo "Build-time Environment Variables:" && \
    echo "=========================================" && \
    echo "VITE_API_BASE_URL: ${VITE_API_BASE_URL}" && \
    echo "VITE_LLM_INFERENCE_ENDPOINT: ${VITE_LLM_INFERENCE_ENDPOINT}" && \
    echo "VITE_APP_ENV: ${VITE_APP_ENV}" && \
    echo "VITE_ENABLE_DEBUG_LOGS: ${VITE_ENABLE_DEBUG_LOGS}" && \
    echo "VITE_ENABLE_PERFORMANCE_MONITORING: ${VITE_ENABLE_PERFORMANCE_MONITORING}" && \
    echo "========================================="

# Build the application with environment variables baked in.
# Heap capped at 4 GB — host (Hetzner 16 GB) is shared with Neo4j,
# workers and the chat container which often sit at ~7 GB combined,
# leaving ~5 GB free. Vite needs ~1.5–2 GB peak for our bundle, so
# 4 GB gives Node plenty of headroom while keeping the runner well
# clear of the OOM-killer (saw `oom-kill` on the 6 GB setting on
# 2026-05-22 when workers were under load).
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build && \
    echo "✓ Build completed"

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install serve to run the production build
RUN npm install -g serve

# Copy built assets from builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# Start the application
CMD ["serve", "-s", "dist", "-l", "3000", "-c", "serve.json"]
