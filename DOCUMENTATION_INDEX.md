# Documentation Index

Complete guide to the Industrial-Grade Code Reviewer system.

## 🚀 Getting Started

### Essential Reading (Start Here)
1. **[README.md](./README.md)** - Overview, architecture, and quick start
2. **[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)** - Step-by-step deployment procedures
3. **[ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md)** - API reference for monitoring
4. **[DEV_OPERATIONS_MANUAL.md](./DEV_OPERATIONS_MANUAL.md)** - Developer setups, local testing, and sandbox configurations

## 🛠️ Operations

### Production Operations
- **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** - Incident response and troubleshooting procedures
- **[ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md)** - Monitoring, metrics, and admin actions

### Configuration
- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** - `.codereview.yml` setup and custom rules
- **[docs/CODEREVIEW_YML_GUIDE.md](./docs/CODEREVIEW_YML_GUIDE.md)** - Complete configuration guide with examples
- **[docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md)** - Zoho Cliq, Slack, and OAuth setup

## 🏗️ Architecture

### System Design
- **[README.md#Architecture](./README.md#architecture-dual-compute-model)** - Dual-compute model overview

### Industrial-Grade Systems
1. **Distributed Rate Limiter** - Token bucket with AIMD, Durable Objects
2. **Cost Circuit Breaker** - Real-time budget tracking, hourly/daily limits
3. **Adaptive Concurrency** - AIMD algorithm, 1-5 concurrent requests
4. **Service Levels** - Graceful degradation (FULL/DEGRADED/DISABLED)
5. **Retry with Backoff** - Exponential backoff with jitter
6. **OpenTelemetry Tracing** - Distributed tracing infrastructure

## �� Monitoring & Metrics

### Admin Endpoints
```bash
# Rate limiter metrics
GET /admin/rate-limiter-metrics/{provider}

# Adaptive concurrency metrics
GET /admin/concurrency-metrics

# Retry statistics
GET /admin/retry-metrics
```

See [ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md) for complete API reference.

## 🎯 Quick Reference

### Deployment
```bash
# 1. Deploy
npx wrangler deploy

# 2. Verify
./scripts/verify-deployment.sh https://your-worker.workers.dev YOUR_API_KEY

# 3. Monitor
curl -H "Authorization: Bearer $API_KEY" \
  https://your-worker.workers.dev/admin/concurrency-metrics
```

### Troubleshooting
- **High error rate** → Check [docs/RUNBOOK.md](./docs/RUNBOOK.md)
- **Rate limit issues** → Check [ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md)
- **Cost overruns** → Check [ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md)

## 📚 Additional Resources

### Scripts
- **[scripts/verify-deployment.sh](./scripts/verify-deployment.sh)** - Automated deployment verification
- **[scripts/usage-client.ts](./scripts/usage-client.ts)** - Usage metrics client

### Configuration Files
- **[wrangler.jsonc](./wrangler.jsonc)** - Cloudflare Workers configuration
- **[.codereview.yml.example](./.codereview.yml.example)** - Repository-specific review rules example
- **[.codereview.yml.starter](./.codereview.yml.starter)** - Minimal starter template

## 🎓 Learning Path

### For Operators
1. Read [README.md](./README.md) - Understand the system
2. Follow [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Deploy to production
3. Learn [ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md) - Monitor the system
4. Study [docs/RUNBOOK.md](./docs/RUNBOOK.md) - Handle incidents

### For Developers
1. Read [README.md](./README.md) - Understand architecture and features
2. Review [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) - Configure for your needs
3. Check [docs/CODEREVIEW_YML_GUIDE.md](./docs/CODEREVIEW_YML_GUIDE.md) - Customize review rules
4. Explore source code in `src/lib/` - See implementations

---

**Last Updated**: April 21, 2026  
**Status**: Production Ready  
**Version**: 1.0.0
