// query-user-mapping.ts — Queries the User Mapping Notion database and returns a routing map.
// Paginates all results. Used by concierge to build live userRouting cache.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

// ==================== TYPES ====================

interface QueryUserMappingInput {
    db_id: string;
    notion_api_key: string;
}

interface QueryUserMappingOutput {
    routing: Record<string, { displayName: string }>;
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

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<QueryUserMappingOutput> {
    const input: QueryUserMappingInput = event.payload;
    const { db_id, notion_api_key } = input;

    if (!db_id || !notion_api_key) {
        throw new Error('Missing required fields: db_id, notion_api_key');
    }

    context.log(`[query-user-mapping] Querying User Mapping DB: ${db_id}`);

    const routing: Record<string, { displayName: string }> = {};
    let cursor: string | undefined;

    do {
        const body: any = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;

        const result = await notionRequest(context, notion_api_key, `databases/${db_id}/query`, 'POST', body);

        for (const page of (result.results || [])) {
            const props = page.properties || {};

            const githubUsername = props['GitHub Username']?.title?.[0]?.plain_text?.trim() || '';
            const displayName = props['Display Name']?.rich_text?.[0]?.plain_text?.trim() || '';

            if (githubUsername) {
                routing[githubUsername] = { displayName: displayName || githubUsername };
            }
        }

        cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    context.log(`[query-user-mapping] Loaded ${Object.keys(routing).length} user entries`);

    return { routing };
}
