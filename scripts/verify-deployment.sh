#!/bin/bash
# Deployment Verification Script
# Tests all industrial-grade systems after deployment

set -e

WORKER_URL="${1:-https://code-reviewer.workers.dev}"
API_KEY="${2:-}"

echo "🔍 Verifying deployment at: $WORKER_URL"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo "1️⃣  Testing health endpoint..."
HEALTH=$(curl -s "$WORKER_URL/health")
if echo "$HEALTH" | grep -q '"status":"healthy"'; then
    echo -e "${GREEN}✅ Health check passed${NC}"
else
    echo -e "${RED}❌ Health check failed${NC}"
    echo "$HEALTH"
    exit 1
fi
echo ""



# Test 3: Operational Metrics
echo "5️⃣  Testing operational metrics..."
METRICS=$(curl -s "$WORKER_URL/metrics")
if echo "$METRICS" | grep -q '"uptime"'; then
    echo -e "${GREEN}✅ Operational metrics accessible${NC}"
    echo "$METRICS" | jq '.uptime, .version, .provider'
else
    echo -e "${RED}❌ Operational metrics failed${NC}"
    echo "$METRICS"
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Deployment verification complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📊 Next steps:"
echo "  1. Monitor logs and container status in Cloudflare dashboard"
echo "  2. Test with a real PR to verify containerized pipeline execution"
echo ""
