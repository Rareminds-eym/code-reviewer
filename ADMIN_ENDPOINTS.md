# 📊 Operational Endpoints Reference

Quick reference for monitoring the AI Code Reviewer system in production.

Following the migration to the Dockerized Container architecture:
- Worker-side in-memory and Durable Object admin endpoints (like `/admin/concurrency-metrics`, `/admin/retry-metrics`, `/admin/rate-limiter-metrics`) have been **removed**.
- Concurrency control and rate limiting are handled within the container runtime environment.
- General health checks and Prometheus metrics endpoints remain active on the edge worker.

---

## 📈 Operational Metrics

Returns global request counters, error rates, and latency stats.

```bash
GET /metrics
```

**Response**:
```json
{
  "uptime": 86400000,
  "version": "1.0.0",
  "provider": "claude",
  "requests": {
    "total": 1250,
    "success": 1180,
    "errors": 70
  },
  "errorRate": 0.056,
  "avgResponseTime": 2500
}
```

### Prometheus Format

To scrape metrics in Prometheus format:

```bash
GET /metrics?format=prometheus
```

---

## 🏥 Health Check

Verifies the state of the Edge Worker and container connectivity bindings.

```bash
GET /health
```

**Response**:
```json
{
  "status": "healthy",
  "service": "code-reviewer",
  "version": "1.0.0",
  "uptime": 86400000,
  "dependencies": {
    "kv": "healthy",
    "queue": "healthy",
    "container": "healthy"
  }
}
```

**Status Values**:
- `healthy` → All systems operational
- `degraded` → Some systems impaired (e.g., container fallback active)
- `unhealthy` → Critical failures

---

## 📊 Monitoring Dashboard

A web-based dashboard is available at `/dashboard` for visual operational statistics and historical metrics lookup.

Access requires authenticated credentials configured via `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`.

---

**Last Updated**: July 4, 2026  
**Version**: 2.0.0 (Containerized Architecture)
