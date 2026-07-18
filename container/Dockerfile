FROM node:20-alpine

# Install system tools needed by the review pipeline.
# python3-dev provides Python.h so pip can compile native C extensions
# (graphify's tree-sitter bindings/grammars) from source on Alpine/musl when
# no musllinux wheel is available — without it, `pip install graphifyy` can fail.
RUN apk add --no-cache \
    git \
    python3 \
    python3-dev \
    py3-pip \
    make \
    g++ \
    build-base

# Install Rust-based fast linters (no node_modules needed, run as standalone binaries)
RUN npm install -g oxlint @biomejs/biome

# Install Semgrep for SAST security scanning
RUN pip3 install --break-system-packages semgrep

# Install Graphify (pinned). The tree-sitter grammars it needs are bundled as pip
# dependencies (tree-sitter-python, tree-sitter-typescript, ...), so this single
# install provides everything `graphify update` (default code-only path),
# `graphify extract` (semantic opt-in) and `affected` need at runtime — no
# build-time parser download and no runtime egress required.
#
# PINNED: the GraphParser (container/src/lib/graphify/graph-parser.ts) targets the
# graphify 0.9.5 node-link schema (graph.json `links`, sidecar `gods[]`). The parser
# test fixtures are generated from this exact version. Bumping this pin requires
# re-verifying those fixtures (see container/test/graphify/) — do not float to latest.
#
# NOTE: `graphify install` is intentionally NOT run — in this graphify version it
# only copies the AI-assistant *skill* into ~/.claude (useless here) and, by writing
# to $HOME, is a needless build-failure risk in a headless container.
RUN pip3 install --break-system-packages graphifyy==0.9.5

# App setup - Deploy cache buster: 2026-07-08T10:22:45
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY dist/ ./dist/

EXPOSE 3000

# Health check for Cloudflare Container readiness detection
# Use node -e fetch instead of wget --spider (busybox wget doesn't support --spider)
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/ping').then(r => process.exit(r.ok?0:1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
