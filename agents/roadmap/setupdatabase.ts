// setup-database.ts — Creates a Notion database with the complete roadmap schema.
// Idempotent: if a database with the same title exists under the parent page, returns existing ID.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

// ==================== TYPES ====================

interface SetupDatabaseInput {
    parent_page_id: string;
    roadmap_name: string;
    notion_api_key: string;
}

interface SetupDatabaseOutput {
    database_id: string;
    project_row_id: string | null;
    created: boolean;
    warnings: string[];
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

function buildDatabaseSchema(parentPageId: string, title: string): any {
    return {
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: title } }],
        is_inline: true,
        properties: {
            'Task/Project Name': {
                title: {}
            },
            'Status': {
                status: {
                    options: [
                        { name: 'Not Started', color: 'default' },
                        { name: 'In Progress', color: 'blue' },
                        { name: 'On Hold', color: 'yellow' },
                        { name: 'Delayed', color: 'red' },
                        { name: 'Completed', color: 'green' }
                    ]
                }
            },
            'Priority': {
                select: {
                    options: [
                        { name: 'High', color: 'red' },
                        { name: 'Medium', color: 'yellow' },
                        { name: 'Low', color: 'green' }
                    ]
                }
            },
            'Row Type': {
                select: {
                    options: [
                        { name: 'Project', color: 'purple' },
                        { name: 'Repo', color: 'blue' },
                        { name: 'Branch', color: 'gray' }
                    ]
                }
            },
            'Risk Signal': {
                select: {
                    options: [
                        { name: 'On Track', color: 'green' },
                        { name: 'At Risk', color: 'yellow' },
                        { name: 'Overdue', color: 'red' },
                        { name: 'Stale', color: 'gray' }
                    ]
                }
            },
            'Project': {
                select: { options: [] }
            },
            'Category': {
                select: { options: [] }
            },
            'Start Date': {
                date: {}
            },
            'End Date': {
                date: {}
            },
            'Progress': {
                number: { format: 'percent' }
            },
            'Last Activity': {
                date: {}
            },
            'Activity Count 7d': {
                number: {}
            },
            'Merged PRs': {
                number: {}
            },
            'Open PRs': {
                number: {}
            },
            'Repo': {
                rich_text: {}
            },
            'Branch': {
                rich_text: {}
            },
            'Execution log': {
                url: {}
            },
            'Owners': {
                multi_select: { options: [] }
            },
            'Blockers': {
                rich_text: {}
            },
            'PR Links': {
                rich_text: {}
            },
            'Notes': {
                rich_text: {}
            },
            'Tags': {
                multi_select: { options: [] }
            }
        }
    };
}

// ==================== SELF-REFERENCING RELATIONS ====================

async function addSelfRelation(
    context: any,
    apiKey: string,
    databaseId: string,
    warnings: string[]
): Promise<void> {
    try {
        await notionRequest(
            context,
            apiKey,
            `databases/${databaseId}`,
            'PATCH',
            {
                properties: {
                    'Blocked by': {
                        relation: {
                            database_id: databaseId,
                            type: 'dual_property',
                            dual_property: {
                                synced_property_name: 'Blocking'
                            }
                        }
                    }
                }
            }
        );
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        warnings.push(`Self-referencing relation failed: ${msg}`);
        context.log(`[ERROR non-fatal] setup-database self-relation: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
    }
}

// ==================== CREATE PROJECT ROW ====================

async function createProjectRow(
    context: any,
    apiKey: string,
    databaseId: string,
    projectName: string
): Promise<string | null> {
    const body = {
        parent: { database_id: databaseId },
        properties: {
            'Task/Project Name': {
                title: [{ type: 'text', text: { content: projectName } }]
            },
            'Row Type': {
                select: { name: 'Project' }
            },
            'Status': {
                status: { name: 'Not Started' }
            }
        }
    };

    const result = await notionRequest(context, apiKey, 'pages', 'POST', body);
    return result.id;
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<SetupDatabaseOutput> {
    const input: SetupDatabaseInput = event.payload;
    const { parent_page_id, roadmap_name, notion_api_key } = input;
    const warnings: string[] = [];

    if (!parent_page_id || !roadmap_name || !notion_api_key) {
        throw new Error('Missing required fields: parent_page_id, roadmap_name, notion_api_key');
    }

    const dbTitle = `${roadmap_name} Roadmap`;

    // Step 1: Idempotency check
    context.log(`Checking for existing database "${dbTitle}" under page ${parent_page_id}`);
    const existingId = await findExistingDatabase(context, notion_api_key, parent_page_id, dbTitle);

    if (existingId) {
        context.log(`Database already exists: ${existingId}`);
        return {
            database_id: existingId,
            project_row_id: null,
            created: false,
            warnings: []
        };
    }

    // Step 2: Create database with full schema
    context.log(`Creating database "${dbTitle}"`);
    const schema = buildDatabaseSchema(parent_page_id, dbTitle);
    const db = await notionRequest(context, notion_api_key, 'databases', 'POST', schema);
    const databaseId = db.id;
    context.log(`Database created: ${databaseId}`);

    // Step 3: Add self-referencing relations (non-fatal)
    await addSelfRelation(context, notion_api_key, databaseId, warnings);

    // Step 4: Create initial Project row
    let projectRowId: string | null = null;
    try {
        projectRowId = await createProjectRow(context, notion_api_key, databaseId, roadmap_name);
        context.log(`Project row created: ${projectRowId}`);
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        warnings.push(`Project row creation failed: ${msg}`);
        context.log(`[ERROR non-fatal] setup-database project row: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
    }

    if (warnings.length > 0) {
        context.log(`Setup completed with warnings: ${warnings.join('; ')}`);
    }

    return {
        database_id: databaseId,
        project_row_id: projectRowId,
        created: true,
        warnings
    };
}
