// update-progress.ts — Update roadmap metrics, blockers, contributors, and risk signal.
// Reads current row state from Notion, computes deltas, writes back.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

// ==================== TYPES ====================

interface UpdateProgressInput {
    repo_row_id: string;
    branch_row_id: string | null;
    project_row_id?: string | null;
    /** Used to resolve property keys from schema (fixes "Invalid property identifier" for UI-created DBs). */
    roadmap_database_id?: string | null;
    repo: string;
    event_type: string;
    action: string | null;
    pr_number: number;
    pr_url: string | null;
    pr_merged: boolean;
    author: string | null;
    author_display_name: string | null;
    branch: string | null;
    review_state: string | null;
    reviewer: string | null;
    notion_api_key: string;
    is_branch_push: boolean;
}

interface UpdateProgressOutput {
    updated: boolean;
    repo_row_id: string;
    branch_updated: boolean;
    project_updated: boolean;
    status: string | null;
    risk_signal: string | null;
    error?: string;
}

// ==================== NOTION API ====================

async function notionRequest(
    context: any,
    apiKey: string,
    path: string,
    method: string = 'GET',
    body?: any
): Promise<any> {
    const opts: any = {
        method,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json'
        }
    };
    if (body) opts.body = JSON.stringify(body);

    const response = await context.fetch(`https://api.notion.com/v1/${path}`, opts);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Notion API ${response.status}: ${errorText}`);
    }
    return await response.json();
}

/** Resolve property key from database schema (by display name or key). Notion may use internal keys that differ from the UI name. */
function getPropertyKey(properties: Record<string, any>, logicalName: string): string | null {
    for (const [key, val] of Object.entries(properties)) {
        if (!val) continue;
        const name = (val as any).name;
        if (name === logicalName || key === logicalName) return key;
    }
    return null;
}

/** Fetch database and return map of logical name -> API key for property writes/filters. */
async function getDatabaseKeys(
    context: any,
    apiKey: string,
    databaseId: string
): Promise<Record<string, string>> {
    const db = await notionRequest(context, apiKey, `databases/${databaseId}`, 'GET');
    const properties = db.properties || {};
    const logicalNames = [
        'Status', 'Last Activity', 'Activity Count 7d', 'Merged PRs', 'Open PRs',
        'Risk Signal', 'Progress', 'Blockers', 'PR Links', 'Owners', 'Start Date', 'End Date'
    ];
    const keys: Record<string, string> = {};
    for (const name of logicalNames) {
        const key = getPropertyKey(properties, name);
        if (key) keys[name] = key;
    }
    return keys;
}

// ==================== CUBBY HELPERS ====================

const CUBBY_NAME = 'executionLogCubby';
const PR_HISTORY_MAX = 50;

function safeKey(s: string): string {
    return (s || '').replace(/[^a-zA-Z0-9-_.]/g, '_');
}

async function getPrHistory(context: any, repo: string): Promise<any[]> {
    const cubby = context.cubby(CUBBY_NAME);
    const key = `roadmap/repo/${safeKey(repo)}/prs`;
    if (await cubby.json.exists(key)) {
        const data = await cubby.json.get(key);
        return Array.isArray(data) ? data : [];
    }
    return [];
}

async function appendPrHistory(context: any, repo: string, entry: any): Promise<any[]> {
    const cubby = context.cubby(CUBBY_NAME);
    const key = `roadmap/repo/${safeKey(repo)}/prs`;
    let arr = await getPrHistory(context, repo);
    arr.push(entry);
    arr = arr.slice(-PR_HISTORY_MAX);
    await cubby.json.set(key, arr);
    return arr;
}

async function getMetrics(context: any, repo: string): Promise<any> {
    const cubby = context.cubby(CUBBY_NAME);
    const key = `roadmap/repo/${safeKey(repo)}/metrics`;
    if (await cubby.json.exists(key)) {
        return await cubby.json.get(key);
    }
    return { total_prs: 0, merged_prs: 0, open_prs: 0, first_activity: null, last_activity: null };
}

async function setMetrics(context: any, repo: string, metrics: any): Promise<void> {
    const cubby = context.cubby(CUBBY_NAME);
    const key = `roadmap/repo/${safeKey(repo)}/metrics`;
    await cubby.json.set(key, metrics);
}

// ==================== PROPERTY READERS ====================

function readNumber(props: any, name: string): number {
    return props[name]?.number ?? 0;
}

function readStatus(props: any): string {
    return props['Status']?.status?.name || 'Not Started';
}

function readDate(props: any, name: string): string | null {
    return props[name]?.date?.start || null;
}

function readRichText(props: any, name: string): string {
    const rt = props[name]?.rich_text || [];
    return rt.map((t: any) => t.plain_text || t.text?.content || '').join('');
}

function readMultiSelect(props: any, name: string): string[] {
    return (props[name]?.multi_select || []).map((o: any) => o.name);
}

// ==================== BLOCKER MANAGEMENT ====================

function addBlocker(currentBlockers: string, newBlocker: string): string {
    const lines = currentBlockers ? currentBlockers.split('\n').filter(Boolean) : [];
    // Avoid duplicate blocker for same PR
    const prMatch = newBlocker.match(/PR #(\d+)/);
    if (prMatch) {
        const prNum = prMatch[1];
        const filtered = lines.filter(l => !l.includes(`PR #${prNum}`));
        filtered.push(newBlocker);
        return filtered.join('\n');
    }
    lines.push(newBlocker);
    return lines.join('\n');
}

function clearBlockerForPr(currentBlockers: string, prNumber: number): string {
    if (!currentBlockers) return '';
    const lines = currentBlockers.split('\n').filter(Boolean);
    return lines.filter(l => !l.includes(`PR #${prNumber}`)).join('\n');
}

// ==================== PR LINKS ====================

function updatePrLinks(currentLinks: string, newUrl: string): string {
    if (!newUrl) return currentLinks;
    const links = currentLinks ? currentLinks.split('\n').filter(Boolean) : [];
    // Remove duplicate
    const filtered = links.filter(l => l !== newUrl);
    filtered.unshift(newUrl);
    // Keep last 3
    return filtered.slice(0, 3).join('\n');
}

// ==================== RISK SIGNAL ====================

function computeRiskSignal(
    lastActivity: string | null,
    endDate: string | null,
    blockers: string,
    status: string,
    mergedPrs: number,
    openPrs: number
): string {
    const now = new Date();

    // Overdue: end date passed, not completed
    if (endDate && status !== 'Completed') {
        const end = new Date(endDate);
        if (end < now) return 'Overdue';
    }

    // Stale: no activity 14+ days
    if (lastActivity) {
        const last = new Date(lastActivity);
        const daysSince = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince >= 14) return 'Stale';

        // At Risk: no activity 7-14 days
        if (daysSince >= 7) return 'At Risk';
    }

    // At Risk: has blockers
    if (blockers && blockers.trim().length > 0) return 'At Risk';

    // At Risk: end date within 7 days and more open than merged
    if (endDate && status !== 'Completed') {
        const end = new Date(endDate);
        const daysUntilEnd = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        if (daysUntilEnd <= 7 && daysUntilEnd > 0 && openPrs > mergedPrs) return 'At Risk';
    }

    return 'On Track';
}

// ==================== PROGRESS ====================

function computeProgress(mergedPrs: number, openPrs: number): number {
    if (mergedPrs === 0 && openPrs === 0) return 0;
    if (mergedPrs === 0) return 0;
    const ratio = mergedPrs / (mergedPrs + openPrs);
    const pct = Math.round(ratio * 100);
    return Math.min(pct, 95); // Cap at 95%; PM marks 100% via Completed
}

// ==================== CONTRIBUTORS ====================

// Template defaults from Pugo that we replace with real contributors
const TEMPLATE_DEFAULTS = ['Me', 'Team A', 'John', 'Sarah', 'Freelancer', 'Everyone'];

function updateContributors(current: string[], authorName: string | null): string[] {
    if (!authorName) return current;
    // Strip template defaults on first real contributor
    let contributors = current.filter(c => !TEMPLATE_DEFAULTS.includes(c));
    if (!contributors.includes(authorName)) {
        contributors.push(authorName);
    }
    return contributors;
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<UpdateProgressOutput> {
    const input: UpdateProgressInput = event.payload;
    const {
        repo_row_id, branch_row_id, project_row_id, roadmap_database_id, repo, action, pr_number, pr_url, pr_merged,
        author, author_display_name, branch, review_state, reviewer,
        notion_api_key, is_branch_push
    } = input;

    if (!repo_row_id) {
        return { updated: false, repo_row_id: '', branch_updated: false, project_updated: false, status: null, risk_signal: null, error: 'no_row_id' };
    }

    context.log(`[task] update-progress started: repo_row_id=${repo_row_id}, action=${action}`);
    context.log(`Updating roadmap progress for row ${repo_row_id} (${action})`);

    try {
        // Resolve property keys from schema (fixes "Invalid property identifier" when DB uses internal keys)
        let keys: Record<string, string> = {};
        if (roadmap_database_id) {
            try {
                keys = await getDatabaseKeys(context, notion_api_key, roadmap_database_id);
            } catch (schemaErr: any) {
                context.log(`[WARN] Could not resolve DB schema: ${schemaErr?.message ?? schemaErr}`);
            }
        }
        const k = (name: string) => keys[name] || name;

        // Read current row
        const page = await notionRequest(context, notion_api_key, `pages/${repo_row_id}`);
        const props = page.properties;

        const now = new Date().toISOString().split('T')[0];
        const contributorName = author_display_name || author || 'unknown';

        // Read current values (use resolved keys when available)
        let currentStatus = (props[k('Status')]?.status?.name) || 'Not Started';
        let mergedPrs = readNumber(props, k('Merged PRs'));
        let openPrs = readNumber(props, k('Open PRs'));
        let activityCount = readNumber(props, k('Activity Count 7d'));
        let blockers = readRichText(props, k('Blockers'));
        let prLinks = readRichText(props, k('PR Links'));
        let contributors = readMultiSelect(props, k('Owners'));
        let endDate = readDate(props, k('End Date'));
        let startDate = readDate(props, k('Start Date'));
        const lastActivity = readDate(props, k('Last Activity')) || now;

        // Track metrics in Cubby
        const metrics = await getMetrics(context, repo);

        // Record PR event in Cubby history
        await appendPrHistory(context, repo, {
            pr_number,
            action,
            pr_url,
            author,
            reviewer,
            merged: pr_merged,
            at: new Date().toISOString()
        });

        // Apply event-specific updates
        const isPush = is_branch_push || action === 'branch_push';
        const isFirstActivity = currentStatus === 'Not Started';

        if (isPush) {
            if (isFirstActivity) {
                currentStatus = 'In Progress';
                if (!startDate) startDate = now;
            }
            activityCount += 1;
        } else if (action === 'opened') {
            openPrs += 1;
            activityCount += 1;
            if (pr_url) prLinks = updatePrLinks(prLinks, pr_url);
            if (isFirstActivity) {
                currentStatus = 'In Progress';
                if (!startDate) startDate = now;
            }
            metrics.total_prs = (metrics.total_prs || 0) + 1;
        } else if (action === 'closed' && pr_merged) {
            // PR merged
            mergedPrs += 1;
            if (openPrs > 0) openPrs -= 1;
            if (pr_url) prLinks = updatePrLinks(prLinks, pr_url);
            blockers = clearBlockerForPr(blockers, pr_number);
            if (currentStatus === 'Delayed' && !blockers.trim()) {
                currentStatus = 'In Progress';
            }
            endDate = now;
            metrics.merged_prs = (metrics.merged_prs || 0) + 1;
        } else if (action === 'reopened') {
            openPrs += 1;
        } else if (action === 'review_changes_requested') {
            const reviewerLabel = reviewer ? `@${reviewer}` : 'reviewer';
            const blockerText = `PR #${pr_number}: changes requested by ${reviewerLabel} (${now})`;
            blockers = addBlocker(blockers, blockerText);
            if (currentStatus !== 'Completed') {
                currentStatus = 'Delayed';
            }
        } else if (action === 'review_approved') {
            blockers = clearBlockerForPr(blockers, pr_number);
            if (currentStatus === 'Delayed' && !blockers.trim()) {
                currentStatus = 'In Progress';
            }
        }

        // Update contributors
        contributors = updateContributors(contributors, contributorName);

        // Update Cubby metrics
        metrics.open_prs = openPrs;
        metrics.merged_prs = mergedPrs;
        if (!metrics.first_activity) metrics.first_activity = new Date().toISOString();
        metrics.last_activity = new Date().toISOString();
        await setMetrics(context, repo, metrics);

        // Set rolling end date for active rows with no end date so Timeline view renders a bar
        if (!endDate && (currentStatus === 'In Progress' || currentStatus === 'Delayed')) {
            const rolling = new Date();
            rolling.setDate(rolling.getDate() + 2);
            endDate = rolling.toISOString().split('T')[0];
        }

        // Compute derived fields
        const riskSignal = computeRiskSignal(lastActivity, endDate, blockers, currentStatus, mergedPrs, openPrs);
        const progress = computeProgress(mergedPrs, openPrs);

        // Build Notion update payload (use resolved keys when available)
        const updateProps: any = {
            [k('Status')]: { status: { name: currentStatus } },
            [k('Last Activity')]: { date: { start: now } },
            [k('Activity Count 7d')]: { number: activityCount },
            [k('Merged PRs')]: { number: mergedPrs },
            [k('Open PRs')]: { number: openPrs },
            [k('Risk Signal')]: { select: { name: riskSignal } },
            [k('Progress')]: { number: progress },
            [k('Owners')]: {
                multi_select: contributors.map((c: string) => ({ name: c }))
            }
        };

        if (blockers !== undefined) {
            updateProps[k('Blockers')] = {
                rich_text: blockers
                    ? [{ type: 'text', text: { content: blockers.slice(0, 2000) } }]
                    : []
            };
        }

        if (prLinks) {
            updateProps[k('PR Links')] = {
                rich_text: [{ type: 'text', text: { content: prLinks.slice(0, 2000) } }]
            };
        }

        if (startDate && !readDate(props, k('Start Date'))) {
            updateProps[k('Start Date')] = { date: { start: startDate } };
        }

        if (endDate && !readDate(props, k('End Date'))) {
            updateProps[k('End Date')] = { date: { start: endDate } };
        }

        // Write repo row update
        await notionRequest(context, notion_api_key, `pages/${repo_row_id}`, 'PATCH', {
            properties: updateProps
        });

        context.log(`Updated repo row ${repo_row_id}: status=${currentStatus}, risk=${riskSignal}, progress=${progress}%, contributors=${contributors.join(',')}`);

        // ---- Update branch row (full mirror of repo-level updates) ----
        let branchUpdated = false;
        if (branch_row_id) {
            try {
                const branchPage = await notionRequest(context, notion_api_key, `pages/${branch_row_id}`);
                const branchProps = branchPage.properties;
                const branchActivityCount = readNumber(branchProps, k('Activity Count 7d'));
                const branchStartDate = readDate(branchProps, k('Start Date'));
                const branchStatus = (branchProps[k('Status')]?.status?.name) || 'Not Started';
                const branchContributors = readMultiSelect(branchProps, k('Owners'));
                const branchMerged = readNumber(branchProps, k('Merged PRs'));
                const branchOpen = readNumber(branchProps, k('Open PRs'));
                const branchBlockers = readRichText(branchProps, k('Blockers'));
                const branchLastActivity = readDate(branchProps, k('Last Activity')) || now;

                // Apply same status logic
                let newBranchStatus = branchStatus;
                const branchIsFirst = branchStatus === 'Not Started';
                if (isPush || action === 'opened') {
                    if (branchIsFirst) newBranchStatus = 'In Progress';
                }
                if (action === 'review_changes_requested' && newBranchStatus !== 'Completed') {
                    newBranchStatus = 'Delayed';
                }

                const newBranchContributors = updateContributors(branchContributors, contributorName);
                const branchRisk = computeRiskSignal(branchLastActivity, null, branchBlockers, newBranchStatus, branchMerged, branchOpen);
                const branchProgress = computeProgress(branchMerged, branchOpen);

                const branchUpdate: any = {
                    [k('Last Activity')]: { date: { start: now } },
                    [k('Activity Count 7d')]: { number: branchActivityCount + 1 },
                    [k('Status')]: { status: { name: newBranchStatus } },
                    [k('Owners')]: { multi_select: newBranchContributors.map((c: string) => ({ name: c })) },
                    [k('Risk Signal')]: { select: { name: branchRisk } },
                    [k('Progress')]: { number: branchProgress },
                };
                if (!branchStartDate) {
                    branchUpdate[k('Start Date')] = { date: { start: now } };
                }
                if (action === 'closed' && pr_merged) {
                    branchUpdate[k('End Date')] = { date: { start: now } };
                } else if (!readDate(branchProps, k('End Date')) && (newBranchStatus === 'In Progress' || newBranchStatus === 'Delayed')) {
                    const rolling = new Date();
                    rolling.setDate(rolling.getDate() + 2);
                    branchUpdate[k('End Date')] = { date: { start: rolling.toISOString().split('T')[0] } };
                }

                await notionRequest(context, notion_api_key, `pages/${branch_row_id}`, 'PATCH', {
                    properties: branchUpdate
                });
                branchUpdated = true;
                context.log(`Updated branch row ${branch_row_id}: status=${newBranchStatus}, risk=${branchRisk}, progress=${branchProgress}%, contributors=${newBranchContributors.join(',')}`);
            } catch (branchErr: any) {
                const branchMsg = branchErr?.message ?? String(branchErr);
                context.log(`[ERROR non-fatal] update-progress branch row: ${branchMsg}`);
                if (branchErr?.stack) context.log(`[ERROR] stack: ${branchErr.stack}`);
            }
        }

        // ---- Update project row (set Start Date and End Date only if not already set — never override) ----
        let projectUpdated = false;
        if (project_row_id) {
            try {
                const projectPage = await notionRequest(context, notion_api_key, `pages/${project_row_id}`);
                const projectProps = projectPage.properties;
                const projectStartDate = readDate(projectProps, k('Start Date'));
                const projectEndDate = readDate(projectProps, k('End Date'));

                const projectUpdate: any = {};
                if (!projectStartDate) {
                    projectUpdate[k('Start Date')] = { date: { start: now } };
                }
                if (!projectEndDate) {
                    const rolling = new Date();
                    rolling.setDate(rolling.getDate() + 2);
                    projectUpdate[k('End Date')] = { date: { start: rolling.toISOString().split('T')[0] } };
                }

                if (Object.keys(projectUpdate).length > 0) {
                    await notionRequest(context, notion_api_key, `pages/${project_row_id}`, 'PATCH', {
                        properties: projectUpdate
                    });
                    context.log(`Updated project row ${project_row_id}: startDate=${projectUpdate[k('Start Date')]?.date?.start ?? '(unchanged)'}, endDate=${projectUpdate[k('End Date')]?.date?.start ?? '(unchanged)'}`);
                } else {
                    context.log(`Project row ${project_row_id}: dates already set, no update needed`);
                }
                projectUpdated = true;
            } catch (projectErr: any) {
                const projectMsg = projectErr?.message ?? String(projectErr);
                context.log(`[ERROR non-fatal] update-progress project row: ${projectMsg}`);
                if (projectErr?.stack) context.log(`[ERROR] stack: ${projectErr.stack}`);
            }
        }

        context.log(`[task] update-progress complete`);

        return {
            updated: true,
            repo_row_id,
            branch_updated: branchUpdated,
            project_updated: projectUpdated,
            status: currentStatus,
            risk_signal: riskSignal
        };

    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR non-fatal] update-progress: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        return { updated: false, repo_row_id, branch_updated: false, project_updated: false, status: null, risk_signal: null, error: msg };
    }
}
