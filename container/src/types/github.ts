// ---------------------------------------------------------------------------
// GitHub Webhook Payload Types
// ---------------------------------------------------------------------------

export interface GitHubUser {
    login: string;
    id: number;
}

export interface GitHubRepository {
    id: number;
    full_name: string;
    html_url: string;
    default_branch: string;
}

export interface GitHubPullRequest {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    diff_url: string;
    patch_url: string;
    draft: boolean;
    commits: number;
    additions: number;
    deletions: number;
    changed_files: number;
    head: {
        ref: string;
        sha: string;
    };
    base: {
        ref: string;
        sha: string;
    };
    user: GitHubUser;
}

export interface PullRequestWebhookPayload {
    action: 'opened' | 'closed' | 'synchronize' | 'reopened' | 'edited' | 'ready_for_review' | string;
    number: number;
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
    sender: GitHubUser;
}

// ---------------------------------------------------------------------------
// GitHub REST API Response Types
// ---------------------------------------------------------------------------

/** A file entry from the GET /repos/{owner}/{repo}/pulls/{pull_number}/files endpoint */
export interface GitHubPRFile {
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    raw_url: string;
    blob_url: string;
    contents_url: string;
}
