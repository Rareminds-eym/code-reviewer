# 🚀 Deployment Guide - Industrial-Grade Code Reviewer

## Prerequisites

- ✅ All integrations complete (verified)
- ✅ TypeScript compilation successful
- ✅ Wrangler.jsonc configured with ReviewContainer
- ✅ Cloudflare account with Workers enabled

## Step 1: Pre-Deployment Checklist

```bash
# Verify TypeScript compilation
npx tsc --noEmit

# Generate types
npx wrangler types

# Check wrangler config
npx wrangler deploy --dry-run
```

## Step 2: Deploy to Production

```bash
# Deploy the worker
npx wrangler deploy

# Expected output:
# ✨ Built successfully
# ✨ Uploaded successfully
# ✨ Deployment complete
```

## Step 3: Verify Deployment

```bash
# Run verification script
./scripts/verify-deployment.sh https://code-reviewer.YOUR_SUBDOMAIN.workers.dev YOUR_API_KEY

# Or manually test endpoints:

# 1. Health check
curl https://code-reviewer.YOUR_SUBDOMAIN.workers.dev/health

# 2. Operational Metrics
curl https://code-reviewer.YOUR_SUBDOMAIN.workers.dev/metrics

# 3. Prometheus Metrics
curl https://code-reviewer.YOUR_SUBDOMAIN.workers.dev/metrics?format=prometheus
```

## Step 4: Monitor Initial Behavior

### Watch Operational Metrics

```bash
# Monitor global request stats
watch -n 5 'curl -s https://code-reviewer.YOUR_SUBDOMAIN.workers.dev/metrics | jq'
```

Expected initial state:
```json
{
  "uptime": 1000,
  "version": "1.0.0",
  "provider": "claude",
  "requests": {
    "total": 0,
    "success": 0,
    "errors": 0
  },
  "errorRate": 0,
  "avgResponseTime": 0
}
```

## Step 5: Test with Real PR

1. Create a test PR in your repository
2. Watch Cloudflare logs: `npx wrangler tail`
3. Observe the systems in action:

### Expected Log Sequence

```
[Rate Limiter] Acquiring capacity for chunk review
[Rate Limiter] Acquired in 0ms, utilization: 2%
[Cost Breaker] Budget check passed: $0.05 / $50.00 (0.1%)
[Adaptive Concurrency] Using concurrency: 2
[Queue] Chunk processed successfully
[Adaptive Concurrency] Recorded success
[Rate Limiter] Released unused tokens
[Cost Breaker] Recorded cost: $0.05
```

### On 429 Error (Rate Limit)

```
[Rate Limiter] API returned 429, reporting error
[Rate Limiter] Adaptive rate reduced to 50% (25 RPM)
[Retry] Retrying after 1000ms backoff
[Rate Limiter] Acquired in 1200ms, utilization: 85%
[Queue] Chunk processed successfully after retry
```

### On High Error Rate

```
[Adaptive Concurrency] Error rate: 15%, decreasing concurrency
[Adaptive Concurrency] Decreased from 3 to 1 (multiplicative decrease)
[Service Level] System health degraded, switching to DEGRADED mode
[Queue] Limiting chunks to 50% due to service level
```

## Step 6: 24-Hour Monitoring

### Metrics to Watch

1. **Error Rate** (Target: <5%)
   - Check Cloudflare dashboard
   - Look for 429/529 errors
   - Verify retry success rate

2. **Cost Metrics** (Target: 30-40% reduction)
   - Monitor hourly spend
   - Check budget utilization
   - Verify cost per PR

3. **Concurrency Adjustments** (Target: 1-5 range)
   - Watch for increases after successes
   - Watch for decreases after errors
   - Verify AIMD algorithm working

4. **Service Level Changes** (Target: 99% FULL)
   - Should stay in FULL mode most of the time
   - DEGRADED only during high load
   - DISABLED only during critical failures

### Cloudflare Dashboard

Navigate to:
- **Workers & Pages** → **code-reviewer** → **Metrics**
- Watch: Requests, Errors, CPU Time, Duration

### Alert Thresholds

Set up alerts for:
- Error rate > 10% (warning)
- Error rate > 20% (critical)
- Cost budget > 80% (warning)
- Cost budget > 95% (critical)
- Concurrency stuck at 1 for >1 hour (warning)

## Step 7: Rollback Plan (If Needed)

If issues occur:

```bash
# 1. Check recent deployments
npx wrangler deployments list

# 2. Rollback to previous version
npx wrangler rollback --message "Rolling back due to [reason]"

# 3. Verify rollback
curl https://code-reviewer.YOUR_SUBDOMAIN.workers.dev/health
```

## Success Criteria

After 24 hours, verify:

- ✅ Error rate < 5%
- ✅ Cost reduction 30-40%
- ✅ Adaptive concurrency working (1-5 range)
- ✅ Service levels responding correctly
- ✅ No production incidents
- ✅ Rate limiter preventing 429s
- ✅ Cost breaker preventing overruns

## Troubleshooting

### Issue: Rate limiter not working

**Symptoms**: Still getting 429 errors

**Check**:
```bash
# Verify binding exists
npx wrangler deployments list
# Look for REVIEW_CONTAINER in bindings
```

**Fix**: Check your Anthropic/Gemini API key limits and ensure the keys are correctly set via `wrangler secret put`.

### Issue: Cost breaker blocking requests

**Symptoms**: "Cost budget exceeded" errors

**Check**: Check container execution logs via `wrangler tail` to check if a single PR's token usage has exceeded the cost thresholds defined in `container/src/config/constants.ts`.

**Fix**: Increase token thresholds in `container/src/config/constants.ts` or wait for the hourly reset window to pass.

## Post-Deployment Tasks

1. **Update Documentation**
   - Document actual error rates achieved
   - Document cost savings achieved
   - Update runbook with production learnings

2. **Set Up Monitoring**
   - Configure Cloudflare alerts
   - Set up cost budget alerts
   - Configure PagerDuty/Slack notifications

3. **Team Training**
   - Share admin endpoint documentation
   - Train team on interpreting metrics
   - Document common troubleshooting steps

4. **Continuous Improvement**
   - Review metrics weekly
   - Tune thresholds based on actual behavior
   - Adjust budgets based on usage patterns

## Next Steps

After successful 24-hour monitoring:

1. ✅ Mark deployment as stable
2. ✅ Update team documentation
3. ✅ Schedule post-mortem review
4. ✅ Plan next optimization phase

---

**Deployment Status**: Ready for production  
**Confidence**: High  
**Risk**: Low  
**Timeline**: 1-2 hours deployment + 24 hours monitoring
