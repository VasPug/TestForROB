// resolve-entry-block.ts — Navigates or creates the Notion toggle block hierarchy for an execution log entry.
// Returns the target branch block ID and week label so the caller can append entries separately.

//@ts-nocheck

// ==================== TYPES ====================

interface ResolveEntryBlockInput {
    /** Page ID (used when writing to a full page). */
    notion_page_id?: string | null;
    /** When set, hierarchy uses block-centric order: week → author → date → repo → branch. */
    notion_parent_block_id?: string | null;
    notion_api_key: string;
    event_date: string;
    author: string | null;
    /** Repository label for repo-level grouping (e.g. "Productivity Agent"). */
    repo?: string | null;
    /** Branch name for branch-centric grouping. Required. */
    branch: string;
    pr_number: number | null;
    link_url: string | null;
    action?: string | null;
    merged?: boolean;
}

interface ResolveEntryBlockOutput {
    block_id: string;
    week: string;
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

async function ensureBlockSupportsChildren(
    context: any,
    apiKey: string,
    blockId: string
): Promise<void> {
    const block = await notionRequest(context, apiKey, `blocks/${blockId}`);
    const type = block.type;
    if ((type === 'heading_1' || type === 'heading_2' || type === 'heading_3')
        && !block[type]?.is_toggleable) {
        context.log(`Converting ${type} block ${blockId} to toggle heading`);
        await notionRequest(context, apiKey, `blocks/${blockId}`, 'PATCH', {
            [type]: { rich_text: block[type].rich_text, is_toggleable: true }
        });
    }
}

function extractPlainText(richTextArray: any[]): string {
    return (richTextArray || [])
        .map((item: any) => item.plain_text || item.text?.content || '')
        .join('');
}

// ==================== DATE UTILITIES ====================

function formatDate(d: Date): string {
    return d.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

function firstMondayOfYear(year: number): Date {
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const dow = jan1.getUTCDay() || 7; // 1=Mon … 7=Sun
    const offset = dow === 1 ? 0 : (8 - dow);
    return new Date(Date.UTC(year, 0, 1 + offset));
}

function firstMondayWeek(date: Date): { year: number; week: number } {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const year = d.getUTCFullYear();
    const firstMonday = firstMondayOfYear(year);
    const daysSince = Math.floor((d.getTime() - firstMonday.getTime()) / 86400000);
    if (daysSince < 0) {
        const prevFirstMonday = firstMondayOfYear(year - 1);
        const prevDays = Math.floor((d.getTime() - prevFirstMonday.getTime()) / 86400000);
        return { year: year - 1, week: Math.floor(prevDays / 7) + 1 };
    }
    return { year, week: Math.floor(daysSince / 7) + 1 };
}

function weekPrefixLabel(d: Date): string {
    const w = firstMondayWeek(d);
    return `KD Week ${w.year}-${String(w.week).padStart(2, '0')}`;
}

function weekBounds(date: Date): { monday: Date; friday: Date } {
    const d = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ));
    const day = d.getUTCDay() || 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - (day - 1));
    const friday = new Date(monday);
    friday.setUTCDate(monday.getUTCDate() + 4);
    return { monday, friday };
}

function toISODateString(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function dateMentionRichText(date: Date): any {
    return {
        type: 'mention',
        mention: {
            type: 'date',
            date: { start: toISODateString(date), end: null }
        }
    };
}

// ==================== TOGGLE MANAGEMENT ====================

const blocksChildrenPath = (parentId: string) => `blocks/${parentId}/children`;

async function getBlockChildren(
    context: any,
    apiKey: string,
    blockId: string
): Promise<any[]> {
    const result = await notionRequest(context, apiKey, `blocks/${blockId}/children?page_size=100`);
    return result.results || [];
}

function findWeekToggleInResults(results: any[], prefix: string): string | null {
    for (const block of results || []) {
        if (block.type !== 'toggle') continue;
        const title = extractPlainText(block.toggle?.rich_text || []).trim();
        if (!title.startsWith(prefix)) continue;
        return block.id;
    }
    return null;
}

async function findOrCreateToggle(
    context: any,
    apiKey: string,
    parentId: string,
    prefix: string,
    date: Date
): Promise<string> {
    const { monday, friday } = weekBounds(date);
    const mondayLabel = formatDate(monday);
    const fridayLabel = formatDate(friday);
    const fullTitlePlain = `${prefix} [${mondayLabel} – ${fridayLabel}]`;

    let blocks = await notionRequest(context, apiKey, `${blocksChildrenPath(parentId)}?page_size=100`);
    let existing = findWeekToggleInResults(blocks.results, prefix);
    if (existing) {
        context.log(`Found existing toggle: ${fullTitlePlain}`);
        return existing;
    }

    // Fallback: week toggle may be wrapped in a synced_block. Check source blocks only.
    for (const block of blocks.results || []) {
        if (block.type !== 'synced_block') continue;
        if (block.synced_block?.synced_from !== null) continue; // skip copies, only traverse sources
        const innerChildren = await getBlockChildren(context, apiKey, block.id);
        const innerMatch = findWeekToggleInResults(innerChildren, prefix);
        if (innerMatch) {
            context.log(`Found week toggle inside synced_block ${block.id}: ${prefix}`);
            return innerMatch;
        }
    }

    context.log(`Creating new toggle: ${fullTitlePlain}`);

    // Re-fetch before create to avoid duplicate week toggles when two events race (both saw 0 blocks)
    blocks = await notionRequest(context, apiKey, `${blocksChildrenPath(parentId)}?page_size=100`);
    existing = findWeekToggleInResults(blocks.results, prefix);
    if (existing) {
        context.log(`Found existing toggle on re-check (race avoided): ${fullTitlePlain}`);
        return existing;
    }

    // Re-check synced_block wrappers on the re-fetch too
    for (const block of blocks.results || []) {
        if (block.type !== 'synced_block') continue;
        if (block.synced_block?.synced_from !== null) continue;
        const innerChildren = await getBlockChildren(context, apiKey, block.id);
        const innerMatch = findWeekToggleInResults(innerChildren, prefix);
        if (innerMatch) {
            context.log(`Found week toggle inside synced_block ${block.id} on re-check: ${prefix}`);
            return innerMatch;
        }
    }

    const richText: any[] = [
        { type: 'text', text: { content: `${prefix} ` }, annotations: { bold: true } },
        dateMentionRichText(monday),
        { type: 'text', text: { content: ' – ' }, annotations: { bold: true } },
        dateMentionRichText(friday)
    ];

    const res = await notionRequest(context, apiKey, blocksChildrenPath(parentId), 'PATCH', {
        children: [{ object: 'block', type: 'toggle', toggle: { rich_text: richText } }],
        position: { type: 'end' }
    });

    return res.results[0].id;
}

async function findOrCreateDateBlock(
    context: any,
    apiKey: string,
    toggleId: string,
    date: Date
): Promise<string> {
    const isoDate = toISODateString(date);
    const humanLabel = formatDate(date);
    const children = await getBlockChildren(context, apiKey, toggleId);

    for (const block of children) {
        if (block.type === 'toggle') {
            const rt = block.toggle?.rich_text || [];
            const hasMention = rt.some((t: any) =>
                t.type === 'mention' && t.mention?.type === 'date' && t.mention.date?.start === isoDate
            );
            if (hasMention) {
                context.log(`Found existing date toggle (mention): ${isoDate}`);
                return block.id;
            }
            const text = extractPlainText(rt).trim();
            if (text === `@${humanLabel}` || text === humanLabel) {
                context.log(`Found existing date toggle (text): ${text}`);
                return block.id;
            }
        }
    }

    context.log(`Creating date toggle: ${isoDate}`);
    const res = await notionRequest(context, apiKey, `blocks/${toggleId}/children`, 'PATCH', {
        children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [dateMentionRichText(date)] } }],
        position: { type: 'start' }
    });
    return res.results[0].id;
}

/** Generic find-or-create for plain-text toggle blocks. Used for author and repo toggles. */
async function findOrCreatePlainToggle(
    context: any,
    apiKey: string,
    parentId: string,
    label: string
): Promise<string> {
    const children = await getBlockChildren(context, apiKey, parentId);
    for (const block of children) {
        if (block.type === 'toggle') {
            const text = extractPlainText(block.toggle?.rich_text || []).trim();
            if (text === label) {
                context.log(`Found existing toggle: ${label}`);
                return block.id;
            }
        }
    }
    context.log(`Creating toggle: ${label}`);
    const res = await notionRequest(context, apiKey, `blocks/${parentId}/children`, 'PATCH', {
        children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: label } }] } }],
        position: { type: 'start' }
    });
    return res.results[0].id;
}

function formatAuthorLabel(author: string | null): string {
    const a = (author || 'unknown').trim();
    return a.startsWith('@') ? a : `@${a}`;
}

async function findOrCreateAuthorBlock(
    context: any, apiKey: string, parentId: string, author: string | null
): Promise<string> {
    return findOrCreatePlainToggle(context, apiKey, parentId, formatAuthorLabel(author));
}

async function findOrCreateRepoBlock(
    context: any, apiKey: string, parentId: string, repoLabel: string
): Promise<string> {
    return findOrCreatePlainToggle(context, apiKey, parentId, repoLabel);
}

const BRANCH_TOGGLE_PREFIX = 'Branch: ';

function branchToggleLabel(branchName: string, prNumber: number | null): string {
    const base = `${BRANCH_TOGGLE_PREFIX}${branchName}`;
    if (prNumber != null && prNumber > 0) return `${base} — PR #${prNumber}`;
    return base;
}

function branchToggleMatches(text: string, branchName: string): boolean {
    const prefix = `${BRANCH_TOGGLE_PREFIX}${branchName}`;
    return text === prefix || text.startsWith(`${prefix} — PR #`);
}

async function updateBlockToggleRichText(
    context: any,
    apiKey: string,
    blockId: string,
    label: string,
    linkUrl: string | null
): Promise<void> {
    const textPayload: { content: string; link?: { url: string } } = { content: label };
    if (linkUrl) textPayload.link = { url: linkUrl };
    await notionRequest(context, apiKey, `blocks/${blockId}`, 'PATCH', {
        toggle: { rich_text: [{ type: 'text', text: textPayload }] }
    });
}

async function findOrCreateBranchBlock(
    context: any,
    apiKey: string,
    parentBlockId: string,
    branchName: string,
    linkUrl: string | null,
    prNumber: number | null
): Promise<string> {
    const label = branchToggleLabel(branchName, prNumber);
    const children = await getBlockChildren(context, apiKey, parentBlockId);

    for (const block of children) {
        if (block.type === 'toggle') {
            const text = extractPlainText(block.toggle?.rich_text || []).trim();
            if (branchToggleMatches(text, branchName)) {
                context.log(`Found existing branch toggle: ${text}`);
                if (prNumber != null && prNumber > 0 && !text.includes('PR #') && linkUrl) {
                    try {
                        await updateBlockToggleRichText(context, apiKey, block.id, label, linkUrl);
                        context.log(`Updated branch toggle to: ${label}`);
                    } catch (err: any) {
                        const msg = err?.message ?? String(err);
                        context.log(`[ERROR non-fatal] resolve-entry-block update toggle label: ${msg}`);
                        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
                    }
                }
                return block.id;
            }
        }
    }

    context.log(`Creating branch toggle: ${label}`);
    const textPayload: { content: string; link?: { url: string } } = { content: label };
    if (linkUrl) textPayload.link = { url: linkUrl };
    const res = await notionRequest(context, apiKey, `blocks/${parentBlockId}/children`, 'PATCH', {
        children: [{ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: textPayload }] } }],
        position: { type: 'start' }
    });
    return res.results[0].id;
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<ResolveEntryBlockOutput> {
    const input: ResolveEntryBlockInput = event.payload;
    const rootId = input.notion_parent_block_id ?? input.notion_page_id;
    if (!rootId) {
        throw new Error('resolve-entry-block: provide notion_page_id or notion_parent_block_id');
    }

    context.log(`[task] resolve-entry-block started: root=${rootId}, branch=${input.branch ?? 'n/a'}`);

    if (input.notion_parent_block_id) {
        try {
            await ensureBlockSupportsChildren(context, input.notion_api_key, rootId);
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            if (msg.includes('404') || msg.includes('Could not find block')) {
                throw new Error(
                    `resolve-entry-block: Execution toggle block not found (block ID: ${rootId}). ` +
                    `The block may have been deleted and re-created in Notion. ` +
                    `Update ai_section_block_id in mapping/config Cubby to fix. Original: ${msg}`
                );
            }
            throw err;
        }
    }

    const date = new Date(input.event_date || new Date().toISOString());
    const weekPrefix = weekPrefixLabel(date);
    const branchName = (input.branch || '').trim() || 'unknown';

    const toggleId = await findOrCreateToggle(context, input.notion_api_key, rootId, weekPrefix, date);

    // AI section block: week → author → date → repo → branch. Project page: week → date → author → branch.
    const authorThenDate = !!input.notion_parent_block_id;
    let parentForBranch: string;

    if (authorThenDate) {
        const authorBlockId = await findOrCreateAuthorBlock(context, input.notion_api_key, toggleId, input.author);
        const dateBlockId = await findOrCreateDateBlock(context, input.notion_api_key, authorBlockId, date);
        const repoLabel = (input.repo || '').trim();
        parentForBranch = repoLabel
            ? await findOrCreateRepoBlock(context, input.notion_api_key, dateBlockId, repoLabel)
            : dateBlockId;
    } else {
        const dateBlockId = await findOrCreateDateBlock(context, input.notion_api_key, toggleId, date);
        parentForBranch = await findOrCreateAuthorBlock(context, input.notion_api_key, dateBlockId, input.author);
    }

    // Include PR on branch toggle for merge commits pushed to default branch (merged + branch_push)
    const prNumForLabel =
        input.pr_number != null && input.pr_number > 0 && (input.action !== 'branch_push' || input.merged)
            ? input.pr_number
            : null;
    const toggleLinkUrl = prNumForLabel != null ? (input.link_url || null) : null;

    const branchBlockId = await findOrCreateBranchBlock(
        context, input.notion_api_key, parentForBranch, branchName, toggleLinkUrl, prNumForLabel
    );

    context.log(`[task] resolve-entry-block complete: block_id=${branchBlockId}, week=${weekPrefix}`);
    return { block_id: branchBlockId, week: weekPrefix };
}
