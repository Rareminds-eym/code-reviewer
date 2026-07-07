import { logger } from './logger';
import type { FindingSeverity } from '../types/review';

/**
 * Defines the strict expected payload structure for Zoho Cliq Bot API.
 * Ensures we don't send malformed data that could cause silent drops.
 *
 * Reference: https://www.zoho.com/cliq/help/restapi/v2/#Post_message_to_a_bot
 */
interface CliqBotPayload {
    text: string;
    card: {
        title: string;
        theme: string;
    };
    slides: Array<{
        type: string;
        data: Record<string, string>[];
    }>;
    buttons: Array<{
        label: string;
        type: string;
        action: {
            type: string;
            data: { web: string };
        };
    }>;
    /** Comma-separated user IDs or emails for targeted Bot subscriber messaging */
    userids?: string;
    /** Whether to display bot message synchronously */
    sync_message?: boolean;
}

/**
 * Validates and fetches a fresh, short-lived OAuth access token from Zoho
 * using the permanent refresh token. 
 */
async function getZohoAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
    const url = 'https://accounts.zoho.in/oauth/v2/token';
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to refresh Zoho token: ${response.status} ${errText}`);
    }

    const data = await response.json() as { access_token: string };
    if (!data.access_token) {
        throw new Error('Zoho token response did not contain access_token');
    }

    return data.access_token;
}

/**
 * Response shape from the Cliq Database Records API.
 * Records may wrap field values under a `values` key.
 */
interface CliqDBRecordResponse {
    list?: Array<Record<string, unknown> & { values?: Record<string, unknown> }>;
    data?: Array<Record<string, unknown> & { values?: Record<string, unknown> }>;
}

/**
 * Extracts the first record from a Cliq DB response, normalising both
 * `list` and `data` root keys and optional `values` nesting.
 */
function getFirstRecord(result: CliqDBRecordResponse): Record<string, unknown> | null {
    const records = result.list ?? result.data ?? [];
    if (records.length === 0) return null;
    const first = records[0];
    return (first.values ?? first) as Record<string, unknown>;
}

/**
 * Resolves a GitHub username to a Zoho Cliq ZUID by querying
 * the Cliq Database REST API.
 *
 * Returns `null` if no mapping exists or any error occurs (graceful degradation).
 *
 * Endpoint: GET /api/v2/storages/{db_name}/records?criteria=github_username=={username}
 * Scope required: ZohoCliq.StorageData.READ
 */
/**
 * Resolved Cliq user info: both email and ZUID for flexible mention formats.
 */
interface CliqUserInfo {
    email: string;
    zuid: string;
}

async function resolveCliqUser(
    accessToken: string,
    dbName: string,
    githubUsername: string
): Promise<CliqUserInfo | null> {
    const zohoApiBase = 'https://cliq.zoho.in/api/v2';
    const encDb = encodeURIComponent(dbName);

    // Try exact match first, then case-insensitive fallback.
    // Criteria MUST be wrapped in parentheses per Cliq REST API v2 spec:
    // GET /api/v2/storages/{name}/records?criteria=(field_name==value)
    const criteriaVariants = [
        `(github_username==${githubUsername})`,
        `(github_username==${githubUsername.toLowerCase()})`,
    ];

    for (const criteria of criteriaVariants) {
        const encCriteria = encodeURIComponent(criteria);
        const endpoint = `${zohoApiBase}/storages/${encDb}/records?criteria=${encCriteria}&limit=1`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                logger.warn('Cliq DB lookup failed', {
                    status: response.status,
                    githubUsername,
                    dbName,
                    criteria,
                });
                continue;
            }

            const result = (await response.json()) as CliqDBRecordResponse;
            logger.debug('Cliq DB lookup raw response', { githubUsername, criteria, result });

            const record = getFirstRecord(result);
            if (!record) {
                logger.info('No Cliq mapping found for GitHub user', { githubUsername, criteria });
                continue;
            }

            // Extract both email and ZUID from the record.
            const rawEmail = record.cliq_email ?? record.email;
            const cliqEmail = rawEmail !== undefined && rawEmail !== null ? String(rawEmail).trim() : null;

            const rawZuid = record.cliq_zuid ?? record.zuid;
            const cliqZuid = rawZuid !== undefined && rawZuid !== null ? String(rawZuid).trim() : null;

            if (!cliqEmail && !cliqZuid) {
                logger.warn('Cliq DB record missing both cliq_email and cliq_zuid', { githubUsername, dbName, record });
                continue;
            }

            logger.info('Resolved GitHub user to Cliq user', { githubUsername, cliqEmail, cliqZuid, criteria });
            return {
                email: cliqEmail ?? '',
                zuid: cliqZuid ?? '',
            };
        } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
                logger.warn('Cliq DB lookup timed out (5s)', { githubUsername, criteria });
            } else {
                logger.warn('Cliq DB lookup error', { githubUsername, criteria, error: error instanceof Error ? error.message : String(error) });
            }
            continue;
        }
    }

    return null;
}

/**
 * Maps a standardized GitHub conclusion to a human-readable Client Chat verdict label.
 */
function getVerdictLabel(conclusion: string): string {
    const verdictMap: Record<string, string> = {
        'success': '✅ Approved',
        'failure': '❌ Changes Requested',
        'neutral': '🤔 Needs Discussion',
    };
    return verdictMap[conclusion] || '🤔 Needs Discussion';
}

/**
 * Posts a concise PR review summary to Zoho Cliq via the REST API v2.
 *
 * Authentication: OAuth token passed as `Authorization: Zoho-oauthtoken {token}`
 */
export async function postToCliq(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    botName: string,
    targetId: string,
    repoFullName: string,
    prNumber: number,
    prTitle: string,
    prAuthor: string,
    conclusion: string,
    severityCounts: Record<FindingSeverity, number>,
    dbName?: string,
    pipelineErrors?: string[]
): Promise<void> {
    if (!clientId || !clientSecret || !refreshToken || !botName || !targetId) {
        logger.warn('Skipping Cliq notification: Client ID, Secret, Refresh Token, Bot Name, or Target ID is missing');
        return;
    }

    const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;

    // Safety check: Empty Severity Counts Handling
    const counts = {
        critical: severityCounts?.critical ?? 0,
        high: severityCounts?.high ?? 0,
        medium: severityCounts?.medium ?? 0,
        low: severityCounts?.low ?? 0,
    };
    const totalFindings = counts.critical + counts.high + counts.medium + counts.low;

    const verdictLabel = getVerdictLabel(conclusion);

    // ── Step 0: Resolve GitHub author → Cliq user for @mention ──
    // This runs BEFORE payload construction so we can inject the mention.
    // OAuth token is obtained early as it's needed for both DB lookup and message post.
    let accessToken: string;
    try {
        logger.info('Exchanging Zoho Refresh Token for Access Token', { prNumber, repoFullName });
        accessToken = await getZohoAccessToken(clientId, clientSecret, refreshToken);
    } catch (error) {
        logger.error('Failed to obtain Zoho access token', error instanceof Error ? error : undefined, {
            prNumber, repoFullName,
        });
        return;
    }

    let mentionTag = `@${prAuthor}`; // Fallback: plain GitHub username (no Cliq notification)
    let slideMentionTag = prAuthor; // Fallback for slides (plain text, no mention syntax)
    if (dbName) {
        const cliqUser = await resolveCliqUser(accessToken, dbName, prAuthor);
        if (cliqUser) {
            // Zoho Cliq REST API v2 Mentions (text key):
            //   {@email}  — mention by email (most reliable, works even if ZUID format varies)
            //   {@userid} — mention by ZUID
            // Ref: https://www.zoho.com/cliq/help/restapi/v2/#Mentioning_a_User
            // Prefer email-based mention as it's the canonical Zoho identity.
            if (cliqUser.email) {
                mentionTag = `{@${cliqUser.email}}`;
            } else if (cliqUser.zuid) {
                mentionTag = `{@${cliqUser.zuid}}`;
            }

            // Silent mention for slides/labels: [Name](mail:email) or [Name](zohoid:zuid)
            if (cliqUser.email) {
                slideMentionTag = `[${prAuthor}](mail:${cliqUser.email})`;
            } else if (cliqUser.zuid) {
                slideMentionTag = `[${prAuthor}](zohoid:${cliqUser.zuid})`;
            }

            logger.info('Cliq mention tags constructed', {
                mentionTag,
                slideMentionTag,
                email: cliqUser.email,
                zuid: cliqUser.zuid,
                prAuthor,
            });
        }
    }

    // Determine if we need to show failure warnings
    let titlePrefix = '';
    if (pipelineErrors && pipelineErrors.length > 0) {
        titlePrefix = '⚠️ DEGRADED: ';
    }

    // Strictly typed payload (API Contract)
    const payload: CliqBotPayload = {
        text: `${mentionTag} — AI Code Review completed for **${repoFullName}#${prNumber}**`,
        card: {
            title: `${titlePrefix}PR #${prNumber}: ${prTitle}`,
            theme: 'modern-inline',
        },
        slides: [
            {
                type: 'label',
                data: [
                    { 'Repository': repoFullName },
                    { 'Author': slideMentionTag },
                    { 'Verdict': verdictLabel },
                    { 'Total Findings': String(totalFindings) },
                ],
            },
            {
                type: 'label',
                data: [
                    { '🔴 Critical': String(counts.critical) },
                    { '🟠 High': String(counts.high) },
                    { '🟡 Medium': String(counts.medium) },
                    { '🟢 Low': String(counts.low) },
                ],
            },
        ],
        buttons: [
            {
                label: 'View on GitHub',
                type: '+',
                action: {
                    type: 'open.url',
                    data: { web: prUrl },
                },
            },
        ],
    };

    // Inject Pipeline Errors Slide if any exist
    if (pipelineErrors && pipelineErrors.length > 0) {
        // Limit to 3 errors to prevent blowing up the Cliq message card size
        const errorsToDisplay = pipelineErrors.slice(0, 3);
        const errorText = errorsToDisplay.map(e => `• ${e}`).join('\n');
        const appendTrailing = pipelineErrors.length > 3 ? `\n...and ${pipelineErrors.length - 3} more errors` : '';
        
        payload.slides.push({
            type: 'label',
            data: [
                { 'Pipeline Errors': errorText + appendTrailing }
            ]
        });
    }

    // ── Dynamic API Routing (Enforcing Bot Identity & Target Classification) ──
    const zohoApiBase = 'https://cliq.zoho.in/api/v2';
    const encBotName = encodeURIComponent(botName);
    const encTarget = encodeURIComponent(targetId);
    let endpoint: string;

    if (targetId.startsWith('ch_')) {
        // Post to a Channel by numeric/hash ID, explicitly retaining Bot Identity
        // Ref: https://www.zoho.com/cliq/help/restapi/v2/#Post_message_in_a_channel
        endpoint = `${zohoApiBase}/channels/${targetId}/message?bot_unique_name=${encBotName}`;
    } else if (targetId.includes('@') || /^\d+$/.test(targetId)) {
        // Direct messages (DMs) to an email or numeric ZUID from the Bot using 'userids' payload
        endpoint = `${zohoApiBase}/bots/${encBotName}/message`;
        payload.userids = targetId;
        payload.sync_message = true;
    } else {
        // Fallback: Assume targetId is a Channel Unique Name (e.g. "engineering")
        // Zoho API path routing violently rejects uppercase letters. Sanitize before encoding.
        const safeChannelName = encodeURIComponent(targetId.toLowerCase());
        endpoint = `${zohoApiBase}/channelsbyname/${safeChannelName}/message?bot_unique_name=${encBotName}`;
    }

    try {
        // Proceed with the Notification Dispatch (Hard 10s Timeout)
        // Access token already obtained above for DB lookup + message post.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Zoho Cliq REST API v2 dictates this exact header casing semantics
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 429) {
                    logger.warn('Zoho Cliq API rate limit exceeded. Notification dropped.');
                    return;
                }
                // Removed generic 401/403 suppression to catch exact Zoho JSON errors

                const errText = await response.text();
                throw new Error(`Cliq API error at ${endpoint} (${response.status}): ${errText}`);
            }

            logger.info('Successfully posted review summary to Zoho Cliq', { prNumber, repoFullName, routeType: targetId.startsWith('ch_') ? 'channel' : 'other' });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            throw fetchError;
        }

    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.warn('Zoho Cliq API request timed out (10s limit)', { prNumber, repoFullName });
            return;
        }

        // Non-fatal: a Cliq failure must never break the GitHub review pipeline
        logger.error('Failed to post to Zoho Cliq Bot', error instanceof Error ? error : undefined, {
            prNumber,
            repoFullName,
        });
    }
}
