// We'll write this as a standard Node.js script using the same authentication helpers
import { generateAppJWT } from '../src/lib/github-auth';

// This script can be run on a cron job or server to clean up stale check runs
async function reapStaleCheckRuns() {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

    if (!appId || !privateKey || !installationId) {
        console.error('❌ Missing environment variables GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, or GITHUB_APP_INSTALLATION_ID');
        process.exit(1);
    }

    try {
        console.log('🔄 Authenticating with GitHub App...');
        const jwt = await generateAppJWT(appId, privateKey);
        
        const tokenResponse = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'check-run-reaper',
            }
        });

        if (!tokenResponse.ok) {
            throw new Error(`Auth failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
        }

        const authData = await tokenResponse.json() as { token: string };
        const token = authData.token;

        const headers = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'check-run-reaper',
            'Content-Type': 'application/json',
        };

        console.log('🔍 Fetching repositories for installation...');
        const reposResponse = await fetch('https://api.github.com/installation/repositories', { headers });
        if (!reposResponse.ok) {
            throw new Error(`Failed to fetch repositories: ${reposResponse.status} ${await reposResponse.text()}`);
        }

        const reposData = await reposResponse.json() as { repositories: Array<{ name: string; owner: { login: string }; full_name: string }> };
        
        // Stale threshold: 1 hour
        const staleThreshold = new Date(Date.now() - 60 * 60 * 1000);

        for (const repo of reposData.repositories) {
            console.log(`🔎 Checking stale checks in: ${repo.full_name}`);
            
            // Search check runs in this repo's main branch (or other branches if checked)
            // GitHub API requires ref, we can query for the default branch (usually 'main' or 'master')
            const ref = 'main'; 
            const url = `https://api.github.com/repos/${repo.owner.login}/${repo.name}/commits/${ref}/check-runs?status=in_progress`;
            
            const checksResponse = await fetch(url, { headers });
            if (!checksResponse.ok) {
                console.warn(`⚠️ Could not fetch check runs for ${repo.full_name} on ref ${ref}: ${checksResponse.status}`);
                continue;
            }

            const checksData = await checksResponse.json() as { check_runs: Array<{ id: number; name: string; started_at: string }> };

            for (const run of checksData.check_runs) {
                const startedAt = new Date(run.started_at);
                if (startedAt < staleThreshold) {
                    console.log(`⚠️  Found stale check run: ${run.name} (${run.id}) started at ${run.started_at}. Reaping...`);
                    
                    const updateUrl = `https://api.github.com/repos/${repo.owner.login}/${repo.name}/check-runs/${run.id}`;
                    const updateResponse = await fetch(updateUrl, {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({
                            status: 'completed',
                            conclusion: 'cancelled',
                            output: {
                                title: 'Code Review Aborted',
                                summary: 'The review process was interrupted or timed out. Stale check cleaned up by check-run-reaper.',
                            }
                        })
                    });
                    
                    if (updateResponse.ok) {
                        console.log(`✅ Stale check run ${run.id} updated to cancelled.`);
                    } else {
                        console.error(`❌ Failed to update check run ${run.id}: ${updateResponse.status} ${await updateResponse.text()}`);
                    }
                }
            }
        }

        console.log('🎉 Stale check run reaping process complete.');
    } catch (error) {
        console.error('❌ Reaper failed:', error);
    }
}

// Since check-run-reaper is run via node / tsx, check main module correctly
if (process.argv[1] && (process.argv[1].endsWith('check-run-reaper.ts') || process.argv[1].endsWith('check-run-reaper.js'))) {
    reapStaleCheckRuns();
}
