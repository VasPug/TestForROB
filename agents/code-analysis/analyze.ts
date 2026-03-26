// analyze.ts — LLM-powered code change analysis and execution log decision maker
// Analyzes any code change event (PR or branch push) and generates entry text.

//@ts-nocheck

const INFERENCE_URL = 'https://compute-5.devnet.ddc-dragon.com/inference/api/v1/inference';
const LLM_MODEL = { bucket: 1338, name: 'qwen2-vl-7b-instruct', version: 'v1.0.0' };

// ==================== TYPES ====================

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

interface CodeChangeData {
    event_kind: 'pr' | 'push';
    action: string | null;
    merged: boolean;
    push_branch?: string | null;
    pr_number?: number | null;
    pr_title?: string | null;
    pr_url?: string | null;
    pr_body?: string | null;
    repo: string;
    author: string | null;
    merged_by: string | null;
    merged_at: string | null;
    base_branch: string | null;
    files: PRFile[] | null;
    commits: PRCommit[] | null;
}

interface AnalyzeInput {
    pr_data: CodeChangeData;
}

interface DecisionOutput {
    should_write: boolean;
    entry_text: string;
}

// ==================== PROMPT BUILDING ====================

function buildPrompt(pr: CodeChangeData): string {
    const isPush = pr.event_kind === 'push';

    const actionLabel = pr.merged
        ? 'MERGED'
        : pr.action === 'closed'
            ? 'CLOSED (not merged)'
            : pr.action?.toUpperCase() || 'UNKNOWN';

    let filesSection = 'No file data available.';
    if (pr.files && pr.files.length > 0) {
        const fileSummaries = pr.files.map(f => {
            const stat = `+${f.additions}/-${f.deletions}`;
            const patchSnippet = f.patch
                ? `\n${f.patch.slice(0, 500)}${f.patch.length > 500 ? '\n...(truncated)' : ''}`
                : '';
            return `  ${f.status} ${f.filename} (${stat})${patchSnippet}`;
        });
        filesSection = `${pr.files.length} files changed:\n${fileSummaries.join('\n')}`;
    }

    let commitsSection = 'No commit data available.';
    if (pr.commits && pr.commits.length > 0) {
        const commitLines = pr.commits.map(c =>
            `  ${c.sha.slice(0, 7)} — ${c.message}`
        );
        commitsSection = `${pr.commits.length} commits:\n${commitLines.join('\n')}`;
    }

    const isSyncEvent = !isPush && pr.action === 'synchronize';

    let syncGuidance = '';
    if (isSyncEvent) {
        syncGuidance = `
## SYNCHRONIZE EVENT GUIDANCE
This is a "synchronize" event — new commits were pushed to an already-open PR.
Do NOT just repeat the PR title. Instead, summarize what the NEW push actually changed
by reading the commit messages and file diffs below. Focus on what's different now.
If the commits are small/trivial (e.g. lint fix, typo), say so briefly.
`;
    }

    let pushGuidance = '';
    if (isPush) {
        pushGuidance = `
## PUSH EVENT GUIDANCE
This is a direct branch push. Summarize the actual work from the commits and file diffs.
Write a concrete deliverable — not "pushed N commits to branch X".
If a merge commit is present (merged: true), treat the consolidated work as the deliverable.
If the commits are small/trivial (e.g. lint fix, typo, version bump), say so briefly.
`;
    }

    const eventBlock = isPush
        ? `## PUSH EVENT
- Branch: ${pr.push_branch || pr.base_branch || 'unknown'}
- Repo: ${pr.repo}
- Author: ${pr.author || 'unknown'}${pr.merged ? '\n- Merge commit: true' : ''}`
        : `## PR EVENT
- Action: ${actionLabel}
- PR #${pr.pr_number}: ${pr.pr_title}
- Repo: ${pr.repo}
- Author: ${pr.author || 'unknown'}${pr.merged_by ? `\n- Merged by: ${pr.merged_by}` : ''}${pr.merged_at ? `\n- Merged at: ${pr.merged_at}` : ''}
- Branch: ${pr.base_branch || 'unknown'}
- Description: ${pr.pr_body || '(no description)'}`;

    const intro = isPush
        ? 'A push to a branch just occurred.'
        : 'A PR event just occurred.';

    return `You are an AI that writes execution log entries for a software development team's Notion execution page.

${intro} Analyze it and produce a concise execution log entry that fits the existing format.

## EXECUTION LOG FORMAT

The execution page is structured as follows:

- **Weekly toggle**: "KD Week YYYY-WW (Month Day, Year - Month Day, Year)"
  - **Date toggle**: "@Month Day, Year" (collapsible; newer dates at top)
    - **Author toggle**: "@username" (collapsible)
      - **Branch toggle**: "Branch: <name>" or "Branch: <name> — PR #N" (collapsible; link to PR or commit)
        - Short description of work done (newer entries at top)

You only need to produce the ENTRY text (the short description). The system handles all structural elements.
Do NOT include "(by @author)" in the entry — author is handled separately.

Write entries that state the DELIVERABLE or IMPACT with CONCRETE details. Name what actually changed (components, files, behaviors), not vague labels.

Be SPECIFIC: name the module, component, or behavior. Avoid vague phrases like "new architecture", "improvements", "project execution tracking", "refactored the system" without saying what was built or changed.

Good entry examples (concrete and outcome-focused):
- "Refactored agent visualization pipeline with new component-based UI"
- "Fixed token refresh race condition in auth middleware"
- "Added CI workflow for automated PR labeling"
- "Pushed fix for missing null check in indexer pagination"
- "Auth P95 latency reduced; added retry with backoff"
- "Added week→date→author→branch hierarchy to execution log write-entry"

Bad entry examples (too vague or activity-only — DO NOT write like these):
- "Implemented new architecture for project execution tracking" — vague; name what was implemented (e.g. which toggles, which flow)
- "synchronize PR #161: adding workflow" — just repeats the title
- "Updated PR #42: bug fixes" — says nothing about what changed
- "Opened PR for changes" — meaningless
- "Pushed commits to PR" — activity, not deliverable
- "Improvements to the pipeline" — no concrete detail
- "Pushed N commits to branch X" — activity, not deliverable
${syncGuidance}${pushGuidance}
${eventBlock}

## COMMITS
${commitsSection}

## FILES CHANGED
${filesSection}

## INSTRUCTIONS
1. Write a concise execution log entry (1-3 sentences) that is CONCRETE: name the component, file, or behavior that changed. State the deliverable or impact (what shipped, fixed, or improved). Read the commits and file diffs — do not just parrot the PR title or branch name. Avoid vague phrases like "new architecture", "improvements", "execution tracking" without specifying what was built or changed.
2. For synchronize events, describe what the new push changed (the outcome) with concrete detail.
3. For push events, describe the work done — not that a push occurred.

Respond in this EXACT format (no extra text):
ENTRY: <your execution log entry text>`;
}

// ==================== RESPONSE PARSING ====================

function parseResponse(responseText: string, pr: CodeChangeData): DecisionOutput {
    const entryMatch = responseText.match(/ENTRY:\s*(.+?)(?:\n\n|$)/is);

    const should_write = true;

    let entry_text: string;
    if (entryMatch) {
        entry_text = entryMatch[1].trim();
    } else if (pr.event_kind === 'push') {
        const msgs = (pr.commits || []).slice(-2).map(c => c.message.split('\n')[0]).join('; ');
        const branchName = pr.push_branch || pr.base_branch || 'branch';
        entry_text = msgs
            ? `Pushed to ${branchName}: ${msgs}`
            : `Pushed to ${branchName}`;
    } else {
        entry_text = `PR #${pr.pr_number}: ${pr.pr_title}`;
    }

    return { should_write, entry_text };
}

function buildFallbackDecision(pr: CodeChangeData): DecisionOutput {
    if (pr.event_kind === 'push') {
        const branchName = pr.push_branch || pr.base_branch || 'unknown branch';
        const commitSummaries = (pr.commits || [])
            .slice(-3)
            .map(c => c.message.split('\n')[0])
            .join('; ');
        let entry = commitSummaries
            ? `Pushed to ${branchName}: ${commitSummaries}`
            : `Pushed to branch ${branchName}`;
        if (pr.files && pr.files.length > 0) {
            const totalAdditions = pr.files.reduce((sum, f) => sum + f.additions, 0);
            const totalDeletions = pr.files.reduce((sum, f) => sum + f.deletions, 0);
            entry += ` — ${pr.files.length} files (+${totalAdditions}/-${totalDeletions})`;
        }
        return { should_write: true, entry_text: entry };
    }

    const isSyncEvent = pr.action === 'synchronize';

    let entry: string;

    if (isSyncEvent && pr.commits && pr.commits.length > 0) {
        const commitSummaries = pr.commits
            .slice(-3)
            .map(c => c.message.split('\n')[0])
            .join('; ');
        entry = `Pushed to PR #${pr.pr_number} (${pr.pr_title}): ${commitSummaries}`;
    } else {
        const actionLabel = pr.merged
            ? 'Merged'
            : pr.action === 'closed'
                ? 'Closed'
                : pr.action === 'opened'
                    ? 'Opened'
                    : pr.action || 'Updated';

        entry = `${actionLabel} PR #${pr.pr_number}: ${pr.pr_title}`;
    }

    if (pr.files && pr.files.length > 0) {
        const totalAdditions = pr.files.reduce((sum, f) => sum + f.additions, 0);
        const totalDeletions = pr.files.reduce((sum, f) => sum + f.deletions, 0);
        entry += ` — ${pr.files.length} files (+${totalAdditions}/-${totalDeletions})`;
    }

    return {
        should_write: true,
        entry_text: entry
    };
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<DecisionOutput> {
    const { pr_data }: AnalyzeInput = event.payload;
    context.log(`[task] analyze started: kind=${pr_data.event_kind}, pr=${pr_data.pr_number ?? 'n/a'}, action=${pr_data.action}`);

    const prompt = buildPrompt(pr_data);

    context.log(`Built prompt for ${pr_data.event_kind} event (${prompt.length} chars)`);

    let decision: DecisionOutput;

    try {
        const request = {
            model: LLM_MODEL,
            input: { prompt, max_tokens: 300, temperature: 0.3 }
        };

        const response = await context.fetch(INFERENCE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        });
        if (!response.ok) {
            throw new Error(`LLM call failed: ${response.statusText}: ${await response.text()}`);
        }
        const data = await response.json();

        const rawOutput = data.output?.text || data.output || '';
        const responseText = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);

        context.log(`LLM response received (${responseText.length} chars)`);

        context.log(`LLM response: ${responseText}`);

        decision = parseResponse(responseText, pr_data);
    } catch (error: any) {
        const msg = error?.message ?? String(error);
        context.log(`[ERROR non-fatal] analyze LLM call failed, using fallback: ${msg}`);
        if (error?.stack) context.log(`[ERROR] stack: ${error.stack}`);
        decision = buildFallbackDecision(pr_data);
    }

    context.log(`Decision: should_write=${decision.should_write}`);
    context.log(`[task] analyze complete`);

    return decision;
}
