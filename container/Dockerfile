FROM node:20-alpine

# Install system tools needed by the review pipeline
RUN apk add --no-cache \
    git \
    python3 \
    py3-pip \
    make \
    g++ \
    build-base \
    py3-numpy \
    py3-scipy \
    py3-matplotlib \
    py3-networkx

# Install Rust-based fast linters (no node_modules needed, run as standalone binaries)
RUN npm install -g oxlint @biomejs/biome

# Install Semgrep for SAST security scanning
RUN pip3 install --break-system-packages semgrep

# Install Graphify and download Tree-sitter parsers during build time
# (Must be done at build time since the container lacks egress internet at runtime)
RUN pip3 install --break-system-packages graphifyy && graphify install

# App setup - Deploy cache buster: 2026-07-08T10:22:45
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY dist/ ./dist/

EXPOSE 3000

# Health check for Cloudflare Container readiness detection
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ping || exit 1

CMD ["node", "dist/server.js"]
