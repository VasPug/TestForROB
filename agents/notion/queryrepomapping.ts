// query-repo-mapping.ts — Queries the Repo Mapping Notion database and returns a routing map.
// Paginates all results. Used by concierge to build live repoRouting cache.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

// ==================== TYPES ====================

interface QueryRepoMappingInput {
    db_id: string;
    notion_api_key: string;
}

interface RepoRoute {
    executionPageId: string;
    wikiPageId: string;
    specPageId: string | null;
    label: string;
    project: string;
}

interface QueryRepoMappingOutput {
    routing: Record<string, RepoRoute>;
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

// ==================== HELPERS ====================

function extractPageId(richText: any[]): string {
    if (!richText?.length) return '';
    const t = richText[0];
    if (t.type === 'mention' && t.mention?.type === 'page') {
        return t.mention.page.id?.trim() || '';
    }
    return t.plain_text?.trim() || '';
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<QueryRepoMappingOutput> {
    const input: QueryRepoMappingInput = event.payload;
    const { db_id, notion_api_key } = input;

    if (!db_id || !notion_api_key) {
        throw new Error('Missing required fields: db_id, notion_api_key');
    }

    context.log(`[query-repo-mapping] Querying Repo Mapping DB: ${db_id}`);

    const routing: Record<string, RepoRoute> = {};
    let cursor: string | undefined;

    do {
        const body: any = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;

        const result = await notionRequest(context, notion_api_key, `databases/${db_id}/query`, 'POST', body);

        for (const page of (result.results || [])) {
            const props = page.properties || {};

            const repo = props['Repo']?.title?.[0]?.plain_text?.trim() || '';
            const project = props['Project']?.rich_text?.[0]?.plain_text?.trim() || '';
            const label = props['Label']?.rich_text?.[0]?.plain_text?.trim() || '';
            const executionPageId = extractPageId(props['Execution Page ID']?.rich_text || []);
            const wikiPageId = extractPageId(props['Wiki Page ID']?.rich_text || []);
            const specPageId = extractPageId(props['Spec Page ID']?.rich_text || []) || null;

            if (repo && executionPageId) {
                routing[repo] = {
                    executionPageId,
                    wikiPageId,
                    specPageId: specPageId || null,
                    label: label || repo,
                    project: project || ''
                };
            }
        }

        cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    context.log(`[query-repo-mapping] Loaded ${Object.keys(routing).length} repo entries`);

    return { routing };
}
