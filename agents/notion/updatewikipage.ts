// update-wiki-page.ts — Applies wiki edit instructions to a single Notion page.
// Receives pre-classified section instructions from wiki-scanner; no LLM calls here.

//@ts-nocheck

// ==================== TYPES ====================

interface SectionInstruction {
    heading: string;
    block_id: string | null;
    last_edited_by: string | null;
    type: 'needs_review';
    stale_sentence?: string;
    why?: string;
    suggested_fix?: string;
}

interface UpdateWikiPageInput {
    notion_api_key: string;
    page_id: string;
    page_title: string;
    sections: SectionInstruction[];
    pr_number: number;
    pr_url: string;
}

interface UpdateWikiPageOutput {
    sections_flagged: string[];
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

// ==================== BLOCK COMMENTS ====================

function buildCommentRichText(
    prNumber: number,
    prUrl: string,
    heading: string,
    staleSentence: string,
    why: string,
    suggestedFix: string,
    mentionUserId: string | null
): any[] {
    const parts: any[] = [];
    if (mentionUserId) {
        parts.push({ type: 'mention', mention: { user: { id: mentionUserId } } });
        parts.push({ type: 'text', text: { content: ' ' } });
    }
    parts.push({
        type: 'text',
        text: { content: `PR #${prNumber} flagged "${heading}" for review.\n\n` }
    });
    parts.push({
        type: 'text',
        text: { content: `Stale: ${staleSentence}\n\n` },
        annotations: { italic: true }
    });
    parts.push({
        type: 'text',
        text: { content: `Why: ${why}\n\nSuggested fix: ${suggestedFix}\n\n` }
    });
    parts.push({ type: 'text', text: { content: 'View PR', link: { url: prUrl } } });
    return parts;
}

async function addBlockComment(
    context: any,
    apiKey: string,
    blockId: string,
    prNumber: number,
    prUrl: string,
    heading: string,
    staleSentence: string,
    why: string,
    suggestedFix: string,
    mentionUserId: string | null
): Promise<void> {
    const richText = buildCommentRichText(prNumber, prUrl, heading, staleSentence, why, suggestedFix, mentionUserId);
    await notionRequest(context, apiKey, 'comments', 'POST', {
        parent: { block_id: blockId },
        rich_text: richText
    });
}

async function addPageComment(
    context: any,
    apiKey: string,
    pageId: string,
    prNumber: number,
    prUrl: string,
    sectionNames: string[],
    editorUserIds: string[]
): Promise<void> {
    const richText: any[] = [];

    const uniqueIds = [...new Set(editorUserIds)];
    for (const uid of uniqueIds) {
        richText.push({ type: 'mention', mention: { user: { id: uid } } });
        richText.push({ type: 'text', text: { content: ' ' } });
    }

    const sectionList = sectionNames.join(', ');
    richText.push({
        type: 'text',
        text: { content: `— PR #${prNumber} flagged sections for review: ${sectionList}. See block comments. ` }
    });
    richText.push({
        type: 'text',
        text: { content: `View PR`, link: { url: prUrl } }
    });

    await notionRequest(
        context,
        apiKey,
        'comments',
        'POST',
        {
            parent: { page_id: pageId },
            rich_text: richText
        }
    );
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<UpdateWikiPageOutput> {
    const input: UpdateWikiPageInput = event.payload;

    context.log(`[task] update-wiki-page started: page_id=${input.page_id}, pr=${input.pr_number}`);
    context.log(`Applying wiki edits to page "${input.page_title}" (${input.page_id}) for PR #${input.pr_number}`);

    const dedupSeen = new Set<string>();
    const uniqueInstructions = input.sections.filter(inst => {
        const key = inst.block_id || inst.heading;
        if (dedupSeen.has(key)) return false;
        dedupSeen.add(key);
        return true;
    });

    context.log(`Applying ${uniqueInstructions.length} instructions (${input.sections.length - uniqueInstructions.length} duplicates skipped)`);

    const results = await Promise.allSettled(uniqueInstructions.map(async (inst) => {
        if (!inst.block_id || !inst.stale_sentence) return null;

        const staleSentence = inst.stale_sentence || '(not specified)';
        const why = inst.why || '(not specified)';
        const suggestedFix = inst.suggested_fix || '(not specified)';
        await addBlockComment(
            context, input.notion_api_key, inst.block_id,
            input.pr_number, input.pr_url, inst.heading,
            staleSentence, why, suggestedFix, inst.last_edited_by
        );
        context.log(`Block comment added for: ${inst.heading}`);
        return { heading: inst.heading, editedBy: inst.last_edited_by };
    }));

    const sectionsFlagged: string[] = [];
    const editorUserIds: string[] = [];

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value) {
            sectionsFlagged.push(r.value.heading);
            if (r.value.editedBy) editorUserIds.push(r.value.editedBy);
        } else if (r.status === 'rejected') {
            const reason = r.reason ?? {};
            const msg = reason?.message ?? String(r.reason);
            context.log(`[ERROR non-fatal] update-wiki-page block comment "${uniqueInstructions[i].heading}": ${msg}`);
            if (reason?.stack) context.log(`[ERROR] stack: ${reason.stack}`);
        }
    }

    if (sectionsFlagged.length > 0) {
        if (editorUserIds.length === 0) {
            context.log('No last_edited_by user IDs found — comment will have no @mentions');
        }
        try {
            await addPageComment(
                context,
                input.notion_api_key,
                input.page_id,
                input.pr_number,
                input.pr_url,
                sectionsFlagged,
                editorUserIds
            );
            context.log(`Page comment added, mentioned ${[...new Set(editorUserIds)].length} user(s)`);
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            context.log(`[ERROR non-fatal] update-wiki-page page comment: ${msg}`);
            if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        }
    }

    context.log(`Done: ${sectionsFlagged.length} sections flagged`);
    context.log(`[task] update-wiki-page complete: sections_flagged=${sectionsFlagged.length}`);

    return { sections_flagged: sectionsFlagged };
}
