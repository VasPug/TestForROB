// concierge.ts — Source-agnostic execution log orchestrator
// Receives raw PR events, enriches via source agent (GitHub),
// analyzes via LLM agent, writes to project + author exec pages,
// and updates wiki spec on merge.
// Long-term Cubby: activity:repo:<repo> and activity:person:<author> — last N events for roadmap/timeline.
// Mapping (repo routing, user routing, roadmap DB ID) is read from Cubby at runtime — no hardcoded IDs.

//@ts-nocheck

const ACTIVITY_MAX = 200;
const CUBBY_NAME = 'executionLogCubby';
const CACHE_TTL_MS = 5 * 60 * 1000;

function safeKey(s: string): string {
    return (s || '').replace(/[^a-zA-Z0-9-_.]/g, '_');
}

function cubbyPath(...parts: string[]): string {
    return parts.map(p => safeKey(p)).join('/');
}

/** Log an error with step name, message, and stack. No silent failures. */
function logError(context: any, step: string, err: any, opts?: { fatal?: boolean; nonFatal?: boolean }): void {
    const msg = err?.message ?? (typeof err === 'string' ? err : String(err));
    const stack = err?.stack ?? '';
    const tag = opts?.fatal ? '[ERROR FATAL]' : opts?.nonFatal ? '[ERROR non-fatal]' : '[ERROR]';
    context.log(`${tag} ${step}: ${msg}`);
    if (stack) context.log(`${tag} ${step} stack: ${stack}`);
}

async function appendActivity(context: any, key: string, event: object): Promise<void> {
    const cubby = context.cubby(CUBBY_NAME);
    let arr: any[] = [];
    if (await cubby.json.exists(key)) {
        const list = await cubby.json.get(key);
        if (Array.isArray(list)) arr = list;
    }
    arr.push(event);
    await cubby.json.set(key, arr.slice(-ACTIVITY_MAX));
}

// ==================== TYPES ====================

const REVIEW_ACTIONS = ['review_approved', 'review_changes_requested', 'review_commented'];

/** Scan newest → oldest (GitHub push payload lists commits oldest → newest). */
function mergePrFromPushMessages(
    messages: string[],
    repo: string
): { pr_number: number; pr_url: string; subject_line: string } | null {
    const list = [...(messages || [])].filter((m) => m && String(m).trim());
    for (let i = list.length - 1; i >= 0; i--) {
        const subject_line = String(list[i]).split('\n')[0].slice(0, 240);
        let m = subject_line.match(/Merge pull request #(\d+)/i);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > 0) {
                return {
                    pr_number: n,
                    pr_url: `https://github.com/${repo}/pull/${n}`,
                    subject_line
                };
            }
        }
        m = subject_line.match(/\(#(\d+)\)\s*$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > 0) {
                return {
                    pr_number: n,
                    pr_url: `https://github.com/${repo}/pull/${n}`,
                    subject_line
                };
            }
        }
    }
    return null;
}

function normSha(s: string | null | undefined): string {
    return (s || '').replace(/-/g, '').trim();
}

interface PREventPayload {
    event_type: string;
    action: string | null;
    merged: boolean;
    pr_number: number;
    pr_title: string;
    pr_url: string;
    pr_body: string;
    repo: string;
    author: string | null;
    reviewer?: string | null;
    merged_by: string | null;
    merged_at: string | null;
    base_branch: string | null;
    branch?: string | null;
    before: string | null;
    after: string | null;
    timestamp: string;
    github_token: string;
    notion_page_id: string | null;
    notion_api_key: string | null;
    delivery_id: string | null;
    is_branch_push?: boolean;
    head_sha?: string | null;
    commit_messages?: string[];
    skip_log?: boolean;
    wiki_check_branches?: string;
    merge_commit_sha?: string | null;
}

// ==================== HANDLE ====================

function normalizePayload(raw: any): PREventPayload {
    if (!raw) return raw;
    const pr = raw.pull_request || {};
    const merge_commit_sha = raw.merge_commit_sha ?? pr.merge_commit_sha ?? null;
    if (raw.pr_number != null && raw.pr_title != null) {
        return {
            ...raw,
            merge_commit_sha: merge_commit_sha ?? raw.merge_commit_sha,
            base_branch: raw.base_branch ?? pr.base?.ref ?? raw.base_branch,
            merged: raw.merged ?? pr.merged ?? raw.merged
        } as PREventPayload;
    }
    const branch = raw.branch ?? raw.head_ref ?? pr.head?.ref ?? null;
    return {
        ...raw,
        action: raw.action ?? null,
        merged: raw.merged ?? pr.merged ?? false,
        pr_number: raw.pr_number ?? raw.number ?? pr.number,
        pr_title: raw.pr_title ?? pr.title,
        pr_url: raw.pr_url ?? pr.html_url,
        pr_body: raw.pr_body ?? pr.body ?? '',
        repo: raw.repo ?? raw.repository?.full_name,
        author: raw.author ?? pr.user?.login,
        merged_by: raw.merged_by ?? pr.merged_by?.login ?? null,
        merged_at: raw.merged_at ?? pr.merged_at ?? null,
        base_branch: raw.base_branch ?? pr.base?.ref ?? null,
        branch,
        before: raw.before ?? null,
        after: raw.after ?? null,
        merge_commit_sha,
        timestamp: raw.timestamp ?? pr.updated_at ?? pr.created_at ?? new Date().toISOString()
    } as PREventPayload;
}

async function handle(event: any, context: any): Promise<any> {
    const p = normalizePayload(event.payload || {});

    context.log(`[flow] Concierge handle started: event_type=${p.event_type}, action=${p.action}, repo=${p.repo}, pr_number=${p.pr_number}, branch=${p.branch ?? 'n/a'}, author=${p.author ?? 'n/a'}`);

    if (p.skip_log) {
        context.log('[flow] Skipping log (e.g. merge commit to default branch)');
        return { skipped: true, reason: 'skip_log' };
    }

    const isBranchPush = p.is_branch_push || p.action === 'branch_push';
    const branch = (p.branch || '').trim() || null;

    context.log(`[flow] Processing ${isBranchPush ? `branch ${branch}` : `PR #${p.pr_number}`} (${p.action}) from ${p.repo}`);

    // ---- Validate ----

    if (!branch) {
        context.log('[flow] Validation failed: missing branch (required for branch-centric execution log)');
        return { skipped: true, reason: 'missing_branch' };
    }
    if (!isBranchPush && (!p.pr_number || !p.pr_title || !p.pr_url)) {
        context.log('[flow] Validation failed: missing required PR fields (pr_number, pr_title, or pr_url)');
        return { skipped: true, reason: 'missing_required_fields' };
    }

    const isReviewEvent = p.action && REVIEW_ACTIONS.includes(p.action);
    if (!p.repo) {
        context.log('[flow] Validation failed: missing repo');
        return { skipped: true, reason: 'missing_repo' };
    }
    if (!isBranchPush && !isReviewEvent && !p.github_token) {
        context.log('[flow] Validation failed: missing github_token — cannot enrich PR data');
        return { skipped: true, reason: 'missing_source_credentials' };
    }
    context.log('[flow] Validation passed');

    // ---- Load mapping from Cubby (with 5-min cache refresh) ----
    const cubby = context.cubby(CUBBY_NAME);
    const mappingConfig = (await cubby.json.exists('mapping/config'))
        ? await cubby.json.get('mapping/config')
        : null;

    if (!mappingConfig?.user_mapping_db_id || !mappingConfig?.repo_mapping_db_id) {
        context.log('[concierge] Mapping not configured — run MAPPING_SETUP_REQUEST first.');
        return { ok: false, error: 'mapping_not_configured' };
    }

    const cacheMeta = (await cubby.json.exists('mapping/cache_meta'))
        ? await cubby.json.get('mapping/cache_meta')
        : null;
    const needsRefresh = !cacheMeta || (Date.now() - cacheMeta.cached_at) > CACHE_TTL_MS;

    let userRouting: Record<string, { displayName: string }>;
    let repoRouting: Record<string, { executionPageId: string; wikiPageId: string; specPageId: string | null; label: string; project: string }>;

    if (needsRefresh) {
        try {
            const [userResult, repoResult] = await Promise.all([
                context.agents.notionAgent.queryUserMapping({ db_id: mappingConfig.user_mapping_db_id, notion_api_key: p.notion_api_key }),
                context.agents.notionAgent.queryRepoMapping({ db_id: mappingConfig.repo_mapping_db_id, notion_api_key: p.notion_api_key })
            ]);
            userRouting = userResult.routing;
            repoRouting = repoResult.routing;
            await Promise.all([
                cubby.json.set('mapping/user_routing', userRouting),
                cubby.json.set('mapping/repo_routing', repoRouting),
                cubby.json.set('mapping/cache_meta', { cached_at: Date.now() })
            ]);
            context.log('[flow] Mapping cache refreshed from Notion');
        } catch (err: any) {
            // Fall back to cached on Notion failure
            userRouting = (await cubby.json.exists('mapping/user_routing'))
                ? await cubby.json.get('mapping/user_routing')
                : {};
            repoRouting = (await cubby.json.exists('mapping/repo_routing'))
                ? await cubby.json.get('mapping/repo_routing')
                : {};
            logError(context, 'mapping refresh', err, { nonFatal: true });
            if (!Object.keys(repoRouting).length) {
                return { ok: false, error: 'mapping_unavailable', message: err?.message };
            }
            context.log('[flow] Mapping refresh failed — using stale cache');
        }
    } else {
        userRouting = (await cubby.json.exists('mapping/user_routing'))
            ? await cubby.json.get('mapping/user_routing')
            : {};
        repoRouting = (await cubby.json.exists('mapping/repo_routing'))
            ? await cubby.json.get('mapping/repo_routing')
            : {};
        context.log('[flow] Mapping loaded from cache');
    }

    const roadmapDbId = mappingConfig.roadmap_database_id || null;
    const AI_SECTION_EXECUTION_LOG_BLOCK_ID = mappingConfig.ai_section_block_id || null;

    // ---- Resolve routing ----

    const repoRoute = repoRouting[p.repo];
    const projectPageId = repoRoute?.executionPageId || p.notion_page_id;

    if (!projectPageId) {
        context.log(`[flow] No execution page configured for repo ${p.repo} — skipping write`);
        return { skipped: true, reason: 'no_execution_page_for_repo' };
    }

    context.log(`[flow] Routing: projectPage=${projectPageId}`);

    let suppressExecLogForPrMergeLanding = false;
    if (isBranchPush && p.after) {
        try {
            const landKey = cubbyPath('mergeLandingTip', p.repo, branch);
            if (await cubby.json.exists(landKey)) {
                const row = await cubby.json.get(landKey);
                if (row && normSha(row.sha) === normSha(p.after)) {
                    await cubby.json.delete(landKey);
                    suppressExecLogForPrMergeLanding = true;
                    context.log(
                        '[flow] Exec log skipped for this push — same tip SHA as a PR just merged into this branch'
                    );
                }
            }
        } catch (e: any) {
            logError(context, 'mergeLandingTip cubby read', e, { nonFatal: true });
        }
    }

    let files = [];
    let commits = [];
    let repo_tree: string[] = [];
    let decision;

    // ---- Step 1: Enrich code change data via GitHub agent ----
    // Runs for PR events always. Runs for branch pushes when token + before/after SHAs are available.

    const canEnrichPush = isBranchPush && !!p.github_token && !!p.before && !!p.after;

    if (!isReviewEvent && (!isBranchPush || canEnrichPush)) {
        context.log(`[flow] Step 1 (fetchCode) start${isBranchPush ? ' (branch push)' : ''}`);
        try {
            if (isBranchPush) {
                context.log(`Enriching branch push ${branch} from ${p.repo}`);
            } else {
                context.log(`Enriching PR #${p.pr_number} from ${p.repo}`);
            }

            const enriched = await context.agents.githubAgent.fetchCode({
                repo: p.repo,
                pr_number: isBranchPush ? null : p.pr_number,
                branch: isBranchPush ? branch : null,
                github_token: p.github_token,
                action: p.action,
                before: p.before || null,
                after: p.after || null
            });

            files = enriched.files || [];
            commits = enriched.commits || [];
            repo_tree = enriched.repo_tree || [];

            context.log(`Enriched: ${files.length} files, ${commits.length} commits, ${repo_tree.length} tree entries`);
            context.log('[flow] Step 1 (fetchCode) complete');
        } catch (error: any) {
            logError(context, 'Step 1 (fetchCode)', error, { nonFatal: true });
            context.log('[flow] Step 1 (fetchCode) failed — continuing with empty files/commits');
        }
    } else {
        context.log('[flow] Step 1 (fetchCode) skipped (review, or branch push without token/SHAs)');
    }

    // ---- Step 2: Analyze code change via LLM agent (or build decision for review) ----
    let mergePushPr: { pr_number: number; pr_url: string } | null = null;

    if (isBranchPush) {
        const msgs = p.commit_messages || [];
        mergePushPr = mergePrFromPushMessages(msgs, p.repo);

        if (canEnrichPush && (files.length > 0 || commits.length > 0)) {
            context.log('[flow] Step 2 (analyze) start — branch push LLM');
            try {
                decision = await context.agents.codeAnalysisAgent.analyze({
                    pr_data: {
                        event_kind: 'push',
                        action: p.action,
                        merged: !!mergePushPr,
                        push_branch: branch,
                        repo: p.repo,
                        author: p.author,
                        merged_by: p.merged_by,
                        merged_at: p.merged_at,
                        base_branch: p.base_branch,
                        files,
                        commits
                    }
                });
                context.log(`[flow] Step 2 (analyze push) complete: should_write=${decision.should_write}`);
            } catch (error: any) {
                logError(context, 'Step 2 (analyze push)', error, { nonFatal: true });
                decision = null;
            }
        }

        if (!decision) {
            // Heuristic fallback — used when no token, empty enrichment, or LLM error
            if (mergePushPr) {
                decision = {
                    should_write: true,
                    entry_text:
                        mergePushPr.subject_line || `PR #${mergePushPr.pr_number} merged into ${branch}`
                };
                context.log(`Branch push (heuristic fallback — merge): ${decision.entry_text}`);
            } else {
                const firstLine = (msgs[0] || '').split('\n')[0].slice(0, 120);
                const n = msgs.length;
                const entryText = n === 0
                    ? `Pushed to branch ${branch}`
                    : n === 1
                        ? `Pushed to branch ${branch}: ${firstLine}`
                        : `Pushed ${n} commits to branch ${branch}: ${firstLine}`;
                decision = { should_write: true, entry_text: entryText };
                context.log(`Branch push (heuristic fallback): ${decision.entry_text}`);
            }
        }
    } else if (isReviewEvent) {
        const reviewer = (p.reviewer || 'someone').trim();
        const at = reviewer.startsWith('@') ? reviewer : `@${reviewer}`;
        const entryByAction: Record<string, string> = {
            review_approved: `Review approved by ${at}`,
            review_changes_requested: `Changes requested by ${at}`,
            review_commented: `Review comment by ${at}`
        };
        decision = {
            should_write: true,
            entry_text: entryByAction[p.action!] || `Review by ${at}`
        };
        context.log(`Review event: ${p.action} — ${decision.entry_text}`);
    } else {
        context.log('[flow] Step 2 (analyze) start');
        try {
            context.log(`Analyzing PR #${p.pr_number}`);

            decision = await context.agents.codeAnalysisAgent.analyze({
                pr_data: {
                    event_kind: 'pr',
                    action: p.action,
                    merged: p.merged,
                    pr_number: p.pr_number,
                    pr_title: p.pr_title,
                    pr_url: p.pr_url,
                    pr_body: p.pr_body,
                    repo: p.repo,
                    author: p.author,
                    merged_by: p.merged_by,
                    merged_at: p.merged_at,
                    base_branch: p.base_branch,
                    files,
                    commits
                }
            });

            context.log(`LLM decided: should_write=${decision.should_write}`);
            context.log('[flow] Step 2 (analyze) complete');

        } catch (error: any) {
            logError(context, 'Step 2 (analyze)', error, { fatal: true });
            return { ok: false, error: error?.message ?? String(error), step: 'analyze' };
        }
    }

    // Long-term Cubby: one event per PR for project + person timeline (non-fatal)
    context.log('[flow] Cubby activity append');
    try {
        const at = p.merged_at || p.timestamp || new Date().toISOString();
        const activityEvent = {
            at,
            repo: p.repo,
            pr_number: p.pr_number,
            pr_url: p.pr_url,
            action: p.action,
            merged: p.merged,
            author: p.author,
            entry_text: (decision.entry_text || '').slice(0, 300)
        };
        await appendActivity(context, cubbyPath('activity', 'repo', p.repo), activityEvent);
        if (p.author) {
            await appendActivity(context, cubbyPath('activity', 'person', p.author), activityEvent);
        }
        context.log('[flow] Cubby activity append complete');
    } catch (err: any) {
        logError(context, 'Cubby activity append', err, { nonFatal: true });
    }

    // ---- Steps 3a, 3b, 4: Fan-out in parallel. Steps 5–6 (roadmap) run after so we have execution notes done first. ----
    // Roadmap runs after exec log writes so we can pass entry_text into roadmap Notes.

    context.log('[flow] Preparing parallel steps (3a write project, 3b write author, 4 wiki)');

    const wikiBranches = (p.wiki_check_branches || '')
        .split(',')
        .map((b: string) => b.trim())
        .filter(Boolean);
    const wikiTargetBranch = isBranchPush ? branch : (p.base_branch || '');
    const branchAllowsWiki = wikiBranches.length === 0 || wikiBranches.includes(wikiTargetBranch);
    const shouldWikiCheck =
        branchAllowsWiki &&
        repoRoute?.specPageId &&
        p.notion_api_key &&
        (isBranchPush || p.merged || p.action === 'opened') &&
        !(suppressExecLogForPrMergeLanding && isBranchPush);

    const repoProject = repoRouting[p.repo]
        ? { project: { project: repoRouting[p.repo].project }, repo: repoRouting[p.repo] }
        : null;

    const headBranch = (p.branch || '').trim();
    const baseBranch = (p.base_branch || '').trim();
    const mirrorMergeToBase =
        !isBranchPush &&
        p.merged &&
        p.action === 'closed' &&
        baseBranch &&
        headBranch &&
        baseBranch !== headBranch &&
        p.notion_api_key;

    if (mirrorMergeToBase) {
        try {
            const sha = normSha(p.merge_commit_sha);
            if (sha) {
                await cubby.json.set(
                    cubbyPath('mergeLandingTip', p.repo, baseBranch),
                    { sha }
                );
                context.log(`[flow] mergeLandingTip ${baseBranch}=${sha.slice(0, 7)}… (suppress duplicate push log)`);
            }
        } catch (e: any) {
            logError(context, 'mergeLandingTip cubby set', e, { nonFatal: true });
        }
    }

    const baseMergeEntryText =
        decision.should_write && decision.entry_text
            ? decision.entry_text
            : `PR #${p.pr_number}: ${p.pr_title || ''}`.trim();

    // Builds shared resolve params; callers spread overrides on top.
    function buildResolveParams(overrides: object) {
        return {
            notion_api_key: p.notion_api_key,
            repo: repoRouting[p.repo]?.label ?? p.repo,
            ...overrides
        };
    }

    // ---- Phase A: resolve block IDs + wiki + roadmap match (all in parallel) ----

    type StepResult = { type: string; block_id?: string; week?: string; result?: any; fatalError?: any; error?: string };
    const phaseAPromises: Promise<StepResult>[] = [];

    if (decision.should_write && p.notion_api_key && !suppressExecLogForPrMergeLanding) {
        const mp = mergePushPr;
        const eventDate = (mp ? p.timestamp : p.merged_at) || p.timestamp || new Date().toISOString();
        const prUrl = mp ? mp.pr_url : p.pr_url;
        const headResolveParams = buildResolveParams({
            event_date: eventDate,
            link_url: prUrl,
            pr_number: mp ? mp.pr_number : p.pr_number,
            action: p.action,
            merged: p.merged || !!mp,
            author: p.author,
            branch
        });

        // Step 3a: resolve project page block (fatal on failure)
        phaseAPromises.push(
            context.agents.notionAgent
                .resolveEntryBlock({ ...headResolveParams, notion_page_id: projectPageId })
                .then((r: any) => {
                    context.log(`Resolved project page block: ${r.block_id} (${r.week})`);
                    return { type: '3a', block_id: r.block_id, week: r.week };
                })
                .catch((err: any) => {
                    logError(context, 'Step 3a (resolve project page)', err, { fatal: true });
                    return { type: '3a', fatalError: err };
                })
        );

        // Step 3b: resolve AI section block (non-fatal)
        if (AI_SECTION_EXECUTION_LOG_BLOCK_ID) {
            phaseAPromises.push(
                context.agents.notionAgent
                    .resolveEntryBlock({ ...headResolveParams, notion_parent_block_id: AI_SECTION_EXECUTION_LOG_BLOCK_ID })
                    .then((r: any) => {
                        context.log(`Resolved AI section block: ${r.block_id}`);
                        return { type: '3b', block_id: r.block_id, week: r.week };
                    })
                    .catch((err: any) => {
                        logError(context, 'Step 3b (resolve AI section)', err, { nonFatal: true });
                        return { type: '3b', error: err?.message ?? String(err) };
                    })
            );
        }
    } else if (suppressExecLogForPrMergeLanding) {
        context.log('[flow] Skipping 3a/3b — merge landing push (already logged on PR merged)');
    } else if (!decision.should_write) {
        context.log(`Skipping write for PR #${p.pr_number} — LLM decided not to log`);
    } else {
        context.log('Analysis complete but no notion_api_key — skipping write');
    }

    // Same merge on base branch (e.g. development): Merged + → Merged, so the integration branch
    // does not only show a later "Push: N commits…" when the PR merge push is suppressed.
    if (mirrorMergeToBase && baseMergeEntryText) {
        const mergeDate = p.merged_at || p.timestamp || new Date().toISOString();
        const baseResolveParams = buildResolveParams({
            event_date: mergeDate,
            link_url: p.pr_url,
            pr_number: p.pr_number,
            action: 'closed',
            merged: true,
            author: p.merged_by || p.author,
            branch: baseBranch
        });

        // Step 3aBase: resolve base branch project page (fatal on failure)
        phaseAPromises.push(
            context.agents.notionAgent
                .resolveEntryBlock({ ...baseResolveParams, notion_page_id: projectPageId })
                .then((r: any) => {
                    context.log(`Resolved base branch project page block: ${r.block_id}`);
                    return { type: '3aBase', block_id: r.block_id, week: r.week };
                })
                .catch((err: any) => {
                    logError(context, 'Step 3aBase (resolve base branch project page)', err, { fatal: true });
                    return { type: '3aBase', fatalError: err };
                })
        );

        // Step 3bBase: resolve base branch AI section (non-fatal)
        if (AI_SECTION_EXECUTION_LOG_BLOCK_ID) {
            phaseAPromises.push(
                context.agents.notionAgent
                    .resolveEntryBlock({ ...baseResolveParams, notion_parent_block_id: AI_SECTION_EXECUTION_LOG_BLOCK_ID })
                    .then((r: any) => {
                        context.log(`Resolved base branch AI section block: ${r.block_id}`);
                        return { type: '3bBase', block_id: r.block_id, week: r.week };
                    })
                    .catch((err: any) => {
                        logError(context, 'Step 3bBase (resolve AI section base branch)', err, { nonFatal: true });
                        return { type: '3bBase', error: err?.message ?? String(err) };
                    })
            );
        }
    }

    // Step 4: wiki scan + update (non-fatal) — runs in parallel with Phase A
    if (shouldWikiCheck) {
        const specPageId = repoRoute?.specPageId;
        phaseAPromises.push(
            (async () => {
                try {
                    context.log(`Scanning spec page for PR #${p.pr_number}`);
                    const scanResult = await context.agents.notionAgent.scanWiki({
                        notion_api_key: p.notion_api_key,
                        spec_page_id: specPageId,
                        pr_title: p.pr_title,
                        pr_url: p.pr_url,
                        pr_number: p.pr_number,
                        pr_body: p.pr_body,
                        files,
                        commits,
                        repo_tree,
                        pr_change_summary: decision?.entry_text || ''
                    });
                    context.log(`Wiki scan found ${scanResult.pages?.length || 0} affected pages`);
                    for (const page of (scanResult.pages || [])) {
                        try {
                            context.log(`Updating wiki page "${page.page_title}" (${page.sections.length} sections)`);
                            const updateResult = await context.agents.notionAgent.updateWikiPage({
                                notion_api_key: p.notion_api_key,
                                page_id: page.page_id,
                                page_title: page.page_title,
                                sections: page.sections,
                                pr_number: p.pr_number,
                                pr_url: p.pr_url
                            });
                            context.log(`Page "${page.page_title}": ${updateResult.sections_flagged?.length || 0} flagged`);
                        } catch (err: any) {
                            logError(context, `Step 4 (updateWikiPage "${page.page_title}")`, err, { nonFatal: true });
                        }
                    }
                    context.log('[flow] Step 4 (wiki scan + update) complete');
                    return { type: '4', result: { ok: true } };
                } catch (err: any) {
                    logError(context, 'Step 4 (wiki scan/update)', err, { nonFatal: true });
                    return { type: '4', error: err?.message ?? String(err) };
                }
            })()
        );
    }

    // Step 5: matchTask (non-fatal) — runs in parallel with Phase A
    if (repoProject && roadmapDbId && p.notion_api_key) {
        phaseAPromises.push(
            context.agents.roadmapAgent
                .matchTask({
                    repo: p.repo,
                    branch,
                    repo_label: repoProject.repo?.label || null,
                    roadmap_database_id: roadmapDbId,
                    notion_api_key: p.notion_api_key,
                    project_name: repoProject.project?.project || null,
                    execution_page_id: repoProject.repo?.executionPageId || null
                })
                .then((r: any) => {
                    if (r.matched) context.log(`Roadmap: project=${r.project_row_id}, repo=${r.repo_row_id}, branch=${r.branch_row_id} (created=${r.created})`);
                    return { type: '5', result: r };
                })
                .catch((err: any) => {
                    logError(context, 'Step 5 (matchTask)', err, { nonFatal: true });
                    return { type: '5', result: { matched: false, repo_row_id: null, error: err?.message ?? String(err) } };
                })
        );
    } else if (!repoProject) {
        context.log(`Repo "${p.repo}" not registered in repoRouting. Roadmap tracking skipped.`);
    }

    context.log(`[flow] Phase A: awaiting ${phaseAPromises.length} parallel step(s)`);
    const phaseAResults = await Promise.all(phaseAPromises);
    context.log('[flow] Phase A: all steps completed');

    // Check fatal resolve errors before appending
    const fatalResolve = phaseAResults.find((x: any) => x?.fatalError);
    if (fatalResolve) {
        logError(context, `Step ${fatalResolve.type} (resolve block) — fatal`, fatalResolve.fatalError, { fatal: true });
        return { ok: false, error: fatalResolve.fatalError?.message ?? String(fatalResolve.fatalError), step: 'resolveEntryBlock' };
    }

    // ---- Phase B: Append entries to resolved blocks (parallel) ----
    const resolvedBlocks = phaseAResults.filter((x: any) => x?.block_id);
    if (resolvedBlocks.length > 0) {
        context.log(`[flow] Phase B: appending entries to ${resolvedBlocks.length} resolved block(s)`);
        const appendPromises = resolvedBlocks.map((resolved: any) => {
            const isBase = resolved.type.endsWith('Base');
            const isFatal = resolved.type === '3a' || resolved.type === '3aBase';
            const entryText = isBase ? baseMergeEntryText : decision.entry_text;
            const action = isBase ? 'closed' : p.action;
            const merged = isBase ? true : (p.merged || !!mergePushPr);
            return context.agents.notionAgent
                .appendEntry({ notion_api_key: p.notion_api_key, block_id: resolved.block_id, entry_text: entryText, action, merged })
                .then(() => {
                    context.log(`Appended entry to block ${resolved.block_id} (step ${resolved.type}, week ${resolved.week})`);
                    return { type: resolved.type, result: { ok: true, week: resolved.week } };
                })
                .catch((err: any) => {
                    logError(context, `Step ${resolved.type} (append entry)`, err, isFatal ? { fatal: true } : { nonFatal: true });
                    return isFatal ? { type: resolved.type, fatalError: err } : { type: resolved.type, error: err?.message ?? String(err) };
                });
        });
        const appendResults = await Promise.all(appendPromises);
        context.log('[flow] Phase B: all appends completed');

        const fatalAppend = appendResults.find((x: any) => x?.fatalError);
        if (fatalAppend) {
            logError(context, `Step ${fatalAppend.type} (append) — fatal`, fatalAppend.fatalError, { fatal: true });
            return { ok: false, error: fatalAppend.fatalError?.message ?? String(fatalAppend.fatalError), step: 'appendEntry' };
        }
    }

    // ---- Step 6: Update roadmap progress (after phase A which includes step 5) ----
    const r5 = phaseAResults.find((x: any) => x?.type === '5');
    const matchResult = r5?.result;
    if (matchResult?.matched && matchResult?.repo_row_id) {
        context.log('[flow] Step 6 (updateProgress) start');
        try {
            const authorDisplayName = p.author ? userRouting[p.author]?.displayName : null;
            await context.agents.roadmapAgent.updateProgress({
                repo_row_id: matchResult.repo_row_id,
                branch_row_id: matchResult.branch_row_id || null,
                project_row_id: matchResult.project_row_id || null,
                roadmap_database_id: roadmapDbId,
                repo: p.repo,
                event_type: p.event_type,
                action: p.action,
                pr_number: p.pr_number,
                pr_url: p.pr_url,
                pr_merged: p.merged,
                author: p.author,
                author_display_name: authorDisplayName || p.author,
                branch,
                review_state: isReviewEvent ? p.action : null,
                reviewer: p.reviewer || null,
                notion_api_key: p.notion_api_key,
                is_branch_push: isBranchPush
            });
            context.log('Roadmap progress updated');
            context.log('[flow] Step 6 (updateProgress) complete');
        } catch (err: any) {
            logError(context, 'Step 6 (updateProgress)', err, { nonFatal: true });
        }
    } else if (matchResult?.error) {
        context.log(`[flow] Step 6 skipped: roadmap match returned no row (error: ${matchResult.error})`);
    } else if (!repoProject || !roadmapDbId) {
        context.log('[flow] Step 6 skipped: no roadmap config for repo');
    }

    context.log(`[flow] Concierge handle finished: repo=${p.repo}, pr=${p.pr_number}, action=${p.action}, logged=${decision?.should_write ?? false}`);

    return {
        ok: true,
        pr: p.pr_number,
        action: p.action,
        logged: decision?.should_write || false
    };
}
