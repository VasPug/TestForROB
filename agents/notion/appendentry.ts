// append-entry.ts — Appends an execution log entry to a known Notion block.
// Expects the target block ID to be pre-resolved by resolve-entry-block.

//@ts-nocheck

// ==================== TYPES ====================

interface AppendEntryInput {
    notion_api_key: string;
    /** Branch block ID returned by resolve-entry-block. */
    block_id: string;
    entry_text: string;
    action: string | null;
    merged: boolean;
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

// ==================== ENTRY WRITING ====================

function formatActionVerb(action: string | null, merged: boolean): string {
    if (merged) return 'Merged';
    if (action === 'closed') return 'Closed';
    if (action === 'opened') return 'Opened';
    if (action === 'branch_push') return 'Push';
    if (action === 'review_approved') return 'Review approved';
    if (action === 'review_changes_requested') return 'Changes requested';
    if (action === 'review_commented') return 'Review comment';
    if (action === 'synchronize') return 'Synced';
    return 'Updated';
}

async function appendParagraphBlock(
    context: any,
    apiKey: string,
    blockId: string,
    text: string
): Promise<void> {
    await notionRequest(context, apiKey, `blocks/${blockId}/children`, 'PATCH', {
        children: [{
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: text } }] }
        }],
        position: { type: 'start' }
    });
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<{ ok: true }> {
    const input: AppendEntryInput = event.payload;
    context.log(`[task] append-entry started: block_id=${input.block_id}, action=${input.action}, merged=${input.merged}`);

    const verb = formatActionVerb(input.action, input.merged);
    await appendParagraphBlock(context, input.notion_api_key, input.block_id, `${verb}: ${input.entry_text}`);

    if (input.merged) {
        try {
            await appendParagraphBlock(context, input.notion_api_key, input.block_id, '→ Merged');
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            context.log(`[ERROR non-fatal] append-entry status line: ${msg}`);
            if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        }
    }

    context.log(`[task] append-entry complete: block_id=${input.block_id}`);
    return { ok: true };
}
