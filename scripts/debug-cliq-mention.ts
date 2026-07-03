#!/usr/bin/env npx tsx
/**
 * Debug script to test the Cliq mention flow step by step.
 *
 * Usage:
 *   CLIQ_CLIENT_ID=xxx CLIQ_CLIENT_SECRET=xxx CLIQ_REFRESH_TOKEN=xxx \
 *     npx tsx scripts/debug-cliq-mention.ts [github_username]
 *
 * This script:
 *   1. Gets an OAuth access token from Zoho
 *   2. Queries the Cliq Database for the GitHub username mapping
 *   3. Constructs the mention tag
 *   4. Posts a TEST message to the #PR_Web channel with the mention
 *
 * It logs every HTTP request/response so you can see exactly where things fail.
 */

const ZOHO_API_BASE = 'https://cliq.zoho.in/api/v2';
const ZOHO_ACCOUNTS = 'https://accounts.zoho.in/oauth/v2/token';
const DB_NAME = 'githubusermap';
const BOT_NAME = 'codereviewbot';
const CHANNEL_NAME = 'prweb';

const CLIENT_ID = process.env.CLIQ_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.CLIQ_CLIENT_SECRET ?? '';
const REFRESH_TOKEN = process.env.CLIQ_REFRESH_TOKEN ?? '';
const GITHUB_USERNAME = process.argv[2] ?? 'Anandhageethank';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error('❌ Missing env vars. Set CLIQ_CLIENT_ID, CLIQ_CLIENT_SECRET, CLIQ_REFRESH_TOKEN');
    process.exit(1);
}

console.log('='.repeat(70));
console.log('Cliq Mention Debug Script');
console.log('='.repeat(70));
console.log(`GitHub Username: ${GITHUB_USERNAME}`);
console.log(`DB Name:         ${DB_NAME}`);
console.log(`Bot Name:        ${BOT_NAME}`);
console.log(`Channel:         ${CHANNEL_NAME}`);
console.log('');

// ── Step 1: Get OAuth Access Token ──
async function getAccessToken(): Promise<string> {
    console.log('── Step 1: Getting OAuth Access Token ──');
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: 'refresh_token',
    });

    console.log(`  POST ${ZOHO_ACCOUNTS}`);
    const res = await fetch(ZOHO_ACCOUNTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const text = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Response: ${text}`);

    if (!res.ok) {
        throw new Error(`Token exchange failed: ${res.status} ${text}`);
    }

    const data = JSON.parse(text);
    if (!data.access_token) {
        throw new Error('No access_token in response');
    }

    console.log(`  ✅ Got access token (${data.access_token.substring(0, 20)}...)\n`);
    return data.access_token;
}

// ── Step 2: Query Cliq Database ──
async function queryDatabase(accessToken: string): Promise<{ email: string; zuid: string } | null> {
    console.log('── Step 2: Querying Cliq Database ──');

    // Test multiple criteria formats to see which one works
    const criteriaFormats = [
        { label: 'With parens', criteria: `(github_username==${GITHUB_USERNAME})` },
        { label: 'Without parens', criteria: `github_username==${GITHUB_USERNAME}` },
        { label: 'Lowercase with parens', criteria: `(github_username==${GITHUB_USERNAME.toLowerCase()})` },
        { label: 'List all (no criteria)', criteria: '' },
    ];

    for (const { label, criteria } of criteriaFormats) {
        let endpoint: string;
        if (criteria) {
            const encCriteria = encodeURIComponent(criteria);
            endpoint = `${ZOHO_API_BASE}/storages/${DB_NAME}/records?criteria=${encCriteria}&limit=5`;
        } else {
            endpoint = `${ZOHO_API_BASE}/storages/${DB_NAME}/records?limit=5`;
        }

        console.log(`\n  [${label}]`);
        console.log(`  GET ${endpoint}`);

        try {
            const res = await fetch(endpoint, {
                method: 'GET',
                headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
            });

            const text = await res.text();
            console.log(`  Status: ${res.status}`);
            console.log(`  Response: ${text.substring(0, 500)}`);

            if (res.ok) {
                const data = JSON.parse(text);
                const records = data.list ?? data.data ?? [];
                console.log(`  Records found: ${records.length}`);

                if (records.length > 0) {
                    for (const rec of records) {
                        const values = rec.values ?? rec;
                        console.log(`    Record: ${JSON.stringify(values)}`);
                    }
                }

                // If we found records with criteria, extract the user info
                if (criteria && records.length > 0) {
                    const first = records[0];
                    const values = first.values ?? first;
                    const email = values.cliq_email ?? values.email ?? '';
                    const zuid = values.cliq_zuid ?? values.zuid ?? '';
                    console.log(`\n  ✅ Found user: email=${email}, zuid=${zuid}`);
                    return { email: String(email), zuid: String(zuid) };
                }
            }
        } catch (err) {
            console.log(`  ❌ Error: ${err}`);
        }
    }

    console.log('\n  ❌ No matching record found in any format\n');
    return null;
}

// ── Step 3: Construct and test mention ──
async function testMention(accessToken: string, user: { email: string; zuid: string } | null): Promise<void> {
    console.log('── Step 3: Constructing Mention Tags ──');

    let mentionTag: string;
    let slideMentionTag: string;

    if (user?.email) {
        mentionTag = `{@${user.email}}`;
        slideMentionTag = `[${GITHUB_USERNAME}](mail:${user.email})`;
    } else if (user?.zuid) {
        mentionTag = `{@${user.zuid}}`;
        slideMentionTag = `[${GITHUB_USERNAME}](zohoid:${user.zuid})`;
    } else {
        mentionTag = `@${GITHUB_USERNAME}`;
        slideMentionTag = GITHUB_USERNAME;
    }

    console.log(`  mentionTag (text key):   ${mentionTag}`);
    console.log(`  slideMentionTag (slides): ${slideMentionTag}`);
    console.log('');

    // ── Step 4: Post test message ──
    console.log('── Step 4: Posting Test Message to Channel ──');

    const payload = {
        text: `🧪 DEBUG TEST: ${mentionTag} — mention test for ${GITHUB_USERNAME}`,
        card: {
            title: 'Mention Debug Test',
            theme: 'modern-inline',
        },
        slides: [
            {
                type: 'label',
                data: [
                    { 'Author': slideMentionTag },
                    { 'Test': 'This is a debug message to verify mention tagging' },
                ],
            },
        ],
        buttons: [
            {
                label: 'Dismiss',
                type: '+',
                action: {
                    type: 'open.url',
                    data: { web: 'https://github.com' },
                },
            },
        ],
    };

    const safeChannelName = encodeURIComponent(CHANNEL_NAME.toLowerCase());
    const encBotName = encodeURIComponent(BOT_NAME);
    const endpoint = `${ZOHO_API_BASE}/channelsbyname/${safeChannelName}/message?bot_unique_name=${encBotName}`;

    console.log(`  POST ${endpoint}`);
    console.log(`  Payload: ${JSON.stringify(payload, null, 2)}`);

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Zoho-oauthtoken ${accessToken}`,
            },
            body: JSON.stringify(payload),
        });

        const text = await res.text();
        console.log(`  Status: ${res.status}`);
        console.log(`  Response: ${text}`);

        if (res.ok) {
            console.log('\n  ✅ Message posted successfully! Check the #PR_Web channel.');
        } else {
            console.log('\n  ❌ Message post failed.');
        }
    } catch (err) {
        console.log(`  ❌ Error: ${err}`);
    }
}

// ── Main ──
async function main() {
    try {
        const accessToken = await getAccessToken();
        const user = await queryDatabase(accessToken);
        await testMention(accessToken, user);
    } catch (err) {
        console.error(`\n❌ Fatal error: ${err}`);
        process.exit(1);
    }

    console.log('\n' + '='.repeat(70));
    console.log('Done. Check the output above to identify where the issue is.');
    console.log('='.repeat(70));
}

main();
