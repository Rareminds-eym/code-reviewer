# Code Reviewer Operational Runbook

**Last Updated**: April 20, 2026  
**On-Call Team**: Platform Engineering  
**Escalation**: #platform-oncall Slack channel

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Common Incidents](#common-incidents)
3. [Troubleshooting Procedures](#troubleshooting-procedures)
4. [Emergency Procedures](#emergency-procedures)
5. [Monitoring & Alerts](#monitoring--alerts)
6. [Rollback Procedures](#rollback-procedures)
7. [Escalation Matrix](#escalation-matrix)

---

## System Overview

### Architecture
```
GitHub Webhook → Worker → Queue → Container → LLM APIs → GitHub PR Review
```

### Key Components
- **Worker**: Cloudflare Workers (edge compute)
- **Queue**: Cloudflare Queues (async processing)
- **Container**: Durable Object + Docker (AST/SAST analysis)
- **LLM**: Claude (primary), Gemini (fallback)
- **Storage**: KV (cache, rate limits, cost tracking)

### SLOs
- **Availability**: 99.9% (43 min downtime/month)
- **Latency**: 99% of PRs reviewed in < 5 minutes
- **Error Rate**: < 1% of reviews fail
- **Container Success**: > 90% of container dispatches succeed

---

## Common Incidents

### 1. High Error Rate (529 Overloaded)

**Symptoms**:
- Multiple 529 errors in logs
- Chunk failure rate > 20%
- Alert: "Claude API Overloaded"

**Root Cause**:
- Anthropic API infrastructure overloaded
- Too many concurrent requests
- Rate limiter not working correctly

**Immediate Actions**:
1. Check Claude API status: https://status.anthropic.com
2. Review rate limiter metrics
3. Reduce concurrency if needed

**Long-term Fix**:
- Verify distributed rate limiter is deployed
- Check adaptive rate adjustment is working
- Review retry backoff configuration

---

### 2. Budget Exhaustion

**Symptoms**:
- Alert: "Cost Budget Critical (95%)"
- Reviews returning "Budget exceeded" errors
- Hourly spend > $50

**Immediate Actions**:
1. Check current spend via edge usage API
2. Pause queue processing or suspend webhook deliveries if over budget
3. Identify high-cost repositories

**Long-term Fix**:
- Lower budget limits
- Implement per-repo cost limits
- Add cost anomaly detection

---

### 3. Container Timeouts

**Symptoms**:
- Alert: "Container Timeout Rate > 10%"
- Logs show "Container dispatch failed, falling back"
- Large PRs (>20 files) always timeout

**Immediate Actions**:
1. Check container health
2. Review recent container logs
3. Disable container dispatch temporarily if widespread

**Long-term Fix**:
- Increase timeout to 480s (8 minutes)
- Add progress heartbeats
- Implement streaming response

---

## Emergency Procedures

### Emergency Shutdown

**When to use**: Critical incident, runaway costs, security breach

Steps:
1. Suspend webhook deliveries in the GitHub App settings
2. Verify reviews are paused (incoming webhook deliveries return 503 or fail delivery)
3. Notify team
4. Investigate root cause
5. Fix issue
6. Re-enable GitHub App webhook deliveries

### Emergency Rollback

**When to use**: Bad deployment, breaking change

Steps:
1. Rollback to previous version: `npx wrangler rollback`
2. Verify rollback
3. Check error rate
4. Notify team

---

## Monitoring & Alerts

### Key Metrics

| Metric | Threshold | Alert Level |
|--------|-----------|-------------|
| Error Rate | > 5% | Warning |
| Error Rate | > 10% | Critical |
| 529 Error Rate | > 10% | Warning |
| Container Timeout Rate | > 10% | Warning |
| Hourly Cost | > $40 | Warning |
| Hourly Cost | > $50 | Critical |
| Rate Limit Utilization | > 80% | Warning |
| Rate Limit Utilization | > 90% | Critical |

---

## Escalation Matrix

### Severity Levels

| Severity | Description | Response Time | Escalation |
|----------|-------------|---------------|------------|
| **P0 - Critical** | Service down, data loss | 15 min | Immediate page |
| **P1 - High** | Degraded service, high error rate | 1 hour | Page if not resolved |
| **P2 - Medium** | Partial outage, workaround available | 4 hours | Email notification |
| **P3 - Low** | Minor issue, no user impact | 1 day | Slack notification |

---

**Questions?** Contact #platform-oncall on Slack
