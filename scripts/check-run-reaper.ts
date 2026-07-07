import { Octokit } from '@octokit/rest';
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
        
        const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'check-run-reaper',
            }
        });

        if (!response.ok) {
            throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
        }

        const authData = await response.json() as { token: string };
        const octokit = new Octokit({ auth: authData.token });

        console.log('🔍 Fetching repositories...');
        const repos = await octokit.apps.listReposForOrg({ org: 'gokulrajrz' }); // Adjust organization name if needed
        // Or generic repositories listing
        
        // Fetch check runs for the active repositories
        // Stale threshold: 1 hour
        const staleThreshold = new Date(Date.now() - 60 * 60 * 1000);

        // Best effort: read repos from process env or scan installations
        // A generic installation list can get repositories:
        const installationRepos = await octokit.apps.listInstallationReposForAuthenticatedUser();
        
        for (const repo of installationRepos.data.repositories) {
            console.log(`🔎 Checking stale checks in: ${repo.full_name}`);
            
            // Search check runs in this repo
            const checks = await octokit.checks.listForRef({
                owner: repo.owner.login,
                repo: repo.name,
                ref: 'main', // can list by status or recent commits
                status: 'in_progress',
            });

            for (const run of checks.data.check_runs) {
                const startedAt = new Date(run.started_at);
                if (startedAt < staleThreshold) {
                    console.log(`⚠️  Found stale check run: ${run.name} (${run.id}) started at ${run.started_at}. Reaping...`);
                    
                    await octokit.checks.update({
                        owner: repo.owner.login,
                        repo: repo.name,
                        check_run_id: run.id,
                        status: 'completed',
                        conclusion: 'cancelled',
                        output: {
                            title: 'Code Review Aborted',
                            summary: 'The review process was interrupted or timed out. Stale check cleaned up by check-run-reaper.',
                        }
                    });
                    
                    console.log(`✅ Stale check run ${run.id} updated to cancelled.`);
                }
            }
        }

        console.log('🎉 Stale check run reaping process complete.');
    } catch (error) {
        console.error('❌ Reaper failed:', error);
    }
}

if (require.main === module) {
    reapStaleCheckRuns();
}
