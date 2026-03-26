// fetch-code.ts — Fetches and enriches code change data from the GitHub API
// Handles both PR events and direct branch pushes. Runs server-side on CEF.

//@ts-nocheck

const PATCH_CHAR_LIMIT = 10000;

// ==================== TYPES ====================

interface FetchCodeInput {
    repo: string;
    pr_number?: number | null;
    branch?: string | null;
    github_token: string;
    action?: string | null;
    before?: string | null;
    after?: string | null;
}

interface PRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
}

interface PRCommit {
    sha: string;
    message: string;
}

interface FetchCodeOutput {
    files: PRFile[];
    commits: PRCommit[];
    repo_tree: string[];
}

// ==================== GITHUB API ====================

async function ghApi(
    context: any,
    repo: string,
    path: string,
    token: string
): Promise<any> {
    const url = `https://api.github.com/repos/${repo}/${path}`;
    const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await context.fetch(url, { method: 'GET', headers });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return await res.json();
}

function truncatePatches(files: any[]): PRFile[] {
    if (!files) return [];

    let totalChars = 0;
    return files.map(f => {
        const entry: PRFile = {
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: null,
        };

        if (f.patch && totalChars < PATCH_CHAR_LIMIT) {
            const remaining = PATCH_CHAR_LIMIT - totalChars;
            entry.patch = f.patch.length > remaining
                ? f.patch.slice(0, remaining) + '\n...(truncated)'
                : f.patch;
            totalChars += entry.patch.length;
        }

        return entry;
    });
}

// ==================== HANDLE ====================

async function fetchRepoTree(context: any, repo: string, token: string, ref: string): Promise<string[]> {
    try {
        const data = await ghApi(context, repo, `git/trees/${ref}?recursive=1`, token);
        const items = data.tree || [];
        return items
            .filter((t: any) => t.type === 'blob')
            .map((t: any) => t.path as string)
            .slice(0, 500);
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR non-fatal] fetch-code repo tree: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        return [];
    }
}

async function handle(event: any, context: any): Promise<FetchCodeOutput> {
    const { repo, pr_number, branch, github_token, action, before, after }: FetchCodeInput = event.payload;
    const isSyncWithSHAs = action === 'synchronize' && before && after;
    const isPushOnly = !pr_number && !!before && !!after;
    context.log(`[task] fetch-code started: repo=${repo}, pr=${pr_number ?? 'n/a'}, branch=${branch ?? 'n/a'}, action=${action}`);
    context.log(`[debug] github_token: "${github_token?.slice(0, 10)}..." length=${github_token?.length}`);

    let files: PRFile[] = [];
    let commits: PRCommit[] = [];
    let repo_tree: string[] = [];

    try {
        if (isSyncWithSHAs) {
            const comparison = await ghApi(
                context, repo, `compare/${before}...${after}`, github_token
            );
            files = truncatePatches(comparison.files || []);
            commits = (comparison.commits || []).map((c: any) => ({
                sha: c.sha,
                message: c.commit?.message || '',
            }));
            context.log(`Fetched ${files.length} files, ${commits.length} commits (sync push only)`);
        } else if (isPushOnly) {
            const comparison = await ghApi(
                context, repo, `compare/${before}...${after}`, github_token
            );
            files = truncatePatches(comparison.files || []);
            commits = (comparison.commits || []).map((c: any) => ({
                sha: c.sha,
                message: c.commit?.message || '',
            }));
            context.log(`Fetched ${files.length} files, ${commits.length} commits (branch push compare)`);
        } else {
            const rawFiles = await ghApi(
                context, repo, `pulls/${pr_number}/files?per_page=100`, github_token
            );
            files = truncatePatches(rawFiles);
            context.log(`Fetched ${files.length} files`);

            const rawCommits = await ghApi(
                context, repo, `pulls/${pr_number}/commits?per_page=100`, github_token
            );
            commits = (rawCommits || []).map((c: any) => ({
                sha: c.sha,
                message: c.commit?.message || '',
            }));
            context.log(`Fetched ${commits.length} commits`);
        }
    } catch (error: any) {
        const msg = error?.message ?? String(error);
        context.log(`[ERROR non-fatal] fetch-code data: ${msg}`);
        if (error?.stack) context.log(`[ERROR] stack: ${error.stack}`);
    }

    // Fetch full repo file tree for architecture context.
    // For PRs: look up base branch from PR data. For pushes: use provided branch or fallback to 'main'.
    try {
        let baseBranchRef: string;
        if (!isPushOnly && pr_number) {
            const prData = await ghApi(context, repo, `pulls/${pr_number}`, github_token);
            baseBranchRef = prData?.base?.ref || 'main';
        } else {
            baseBranchRef = branch || 'main';
        }
        repo_tree = await fetchRepoTree(context, repo, github_token, baseBranchRef);
        context.log(`Fetched repo tree: ${repo_tree.length} files`);
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR non-fatal] fetch-code repo tree: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
    }

    context.log(`Enrichment complete: ${files.length} files, ${commits.length} commits, ${repo_tree.length} tree entries`);
    context.log(`[task] fetch-code complete`);

    return { files, commits, repo_tree };
}
