// setup-user-mapping.ts — Creates the User Mapping Notion database.
// Idempotent: if a database titled "User Mapping" already exists under the parent page, returns existing ID.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

// ==================== TYPES ====================

interface SetupUserMappingInput {
    parent_page_id: string;
    notion_api_key: string;
}

interface SetupUserMappingOutput {
    database_id: string;
    created: boolean;
    warnings: string[];
}

const DB_TITLE = 'User Mapping';

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

// ==================== IDEMPOTENCY CHECK ====================

async function findExistingDatabase(
    context: any,
    apiKey: string,
    parentPageId: string,
    expectedTitle: string
): Promise<string | null> {
    let cursor: string | undefined;
    do {
        const params = cursor ? `?start_cursor=${cursor}` : '';
        const result = await notionRequest(
            context,
            apiKey,
            `blocks/${parentPageId}/children${params}`
        );

        for (const block of (result.results || [])) {
            if (block.type === 'child_database') {
                const title = block.child_database?.title || '';
                if (title === expectedTitle) {
                    return block.id;
                }
            }
        }

        cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);

    return null;
}

// ==================== CREATE DATABASE ====================

function buildDatabaseSchema(parentPageId: string): any {
    return {
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: DB_TITLE } }],
        is_inline: true,
        properties: {
            'GitHub Username': {
                title: {}
            },
            'Display Name': {
                rich_text: {}
            },
            'Notion User ID': {
                rich_text: {}
            },
            'Confidence': {
                select: {
                    options: [
                        { name: 'confirmed', color: 'green' },
                        { name: 'inferred', color: 'yellow' },
                        { name: 'unknown', color: 'gray' }
                    ]
                }
            }
        }
    };
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<SetupUserMappingOutput> {
    const input: SetupUserMappingInput = event.payload;
    const { parent_page_id, notion_api_key } = input;
    const warnings: string[] = [];

    if (!parent_page_id || !notion_api_key) {
        throw new Error('Missing required fields: parent_page_id, notion_api_key');
    }

    context.log(`[setup-user-mapping] Checking for existing database "${DB_TITLE}" under page ${parent_page_id}`);
    const existingId = await findExistingDatabase(context, notion_api_key, parent_page_id, DB_TITLE);

    if (existingId) {
        context.log(`[setup-user-mapping] Database already exists: ${existingId}`);
        return { database_id: existingId, created: false, warnings: [] };
    }

    context.log(`[setup-user-mapping] Creating database "${DB_TITLE}"`);
    const schema = buildDatabaseSchema(parent_page_id);
    const db = await notionRequest(context, notion_api_key, 'databases', 'POST', schema);
    const databaseId = db.id;
    context.log(`[setup-user-mapping] Database created: ${databaseId}`);

    if (warnings.length > 0) {
        context.log(`[setup-user-mapping] Warnings: ${warnings.join('; ')}`);
    }

    return { database_id: databaseId, created: true, warnings };
}
