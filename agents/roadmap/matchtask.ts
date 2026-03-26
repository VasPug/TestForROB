// match-task.ts — Find or create Project → Repo → Branch rows in the roadmap Gantt database.
// Three-level hierarchy: Project (top) → Repo (sub of Project) → Branch (sub of Repo).
// V8 isolate: fully inline, no imports.

//@ts-nocheck

// ==================== TYPES ====================

interface MatchTaskInput {
    repo: string;
    branch: string;
    repo_label: string | null;
    roadmap_database_id: string;
    notion_api_key: string;
    project_name: string | null;
    execution_page_id: string | null;
    /** Notion title property name. Must match your database (e.g. "Name" or "Task/Project Name"). */
    title_property_name?: string | null;
}

interface MatchTaskOutput {
    matched: boolean;
    project_row_id: string | null;
    repo_row_id: string | null;
    branch_row_id: string | null;
    repo_name: string;
    created: boolean;
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

/** Fetch database and return the actual API key for a property (by display name or key). Notion may use internal keys that differ from the UI name. */
function getPropertyKey(properties: Record<string, any>, logicalName: string): string | null {
    for (const [key, val] of Object.entries(properties)) {
        if (!val) continue;
        const name = (val as any).name;
        if (name === logicalName || key === logicalName) return key;
    }
    return null;
}

/** Resolve database property keys and title key. Returns map of logical name -> API key so filters/updates use the same keys Notion expects (fixes "Invalid property identifier" for UI-created DBs). */
async function getDatabaseSchema(
    context: any,
    apiKey: string,
    databaseId: string
): Promise<{ titleKey: string; keys: Record<string, string> }> {
    const db = await notionRequest(context, apiKey, `databases/${databaseId}`, 'GET');
    const properties = db.properties || {};
    const logicalNames = [
        'Row Type', 'Repo', 'Branch', 'Project', 'Status', 'Start Date', 'End Date',
        'Last Activity', 'Activity Count 7d', 'Merged PRs', 'Open PRs', 'Risk Signal',
        'Progress', 'Blockers', 'PR Links', 'Execution log', 'Owners', 'Parent item'
    ];
    const keys: Record<string, string> = {};
    for (const name of logicalNames) {
        const key = getPropertyKey(properties, name);
        if (key) keys[name] = key;
    }
    let titleKey = '';
    for (const [key, prop] of Object.entries(properties)) {
        if (prop && (prop as any).type === 'title') {
            titleKey = key;
            break;
        }
    }
    if (!titleKey) throw new Error('Database has no title property');
    return { titleKey, keys };
}

// ==================== QUERY / CREATE PROJECT ====================

async function queryProjectRow(
    context: any,
    apiKey: string,
    databaseId: string,
    projectName: string,
    titleProp: string,
    keys: Record<string, string>
): Promise<string | null> {
    const rowTypeKey = keys['Row Type'] || 'Row Type';
    const body = {
        filter: {
            and: [
                { property: rowTypeKey, select: { equals: 'Project' } },
                { property: titleProp, title: { equals: projectName } }
            ]
        },
        page_size: 1
    };
    const result = await notionRequest(
        context,
        apiKey,
        `databases/${databaseId}/query`,
        'POST',
        body
    );
    if (result.results && result.results.length > 0) {
        return result.results[0].id;
    }
    return null;
}

async function createProjectRow(
    context: any,
    apiKey: string,
    databaseId: string,
    projectName: string,
    titleProp: string,
    keys: Record<string, string>
): Promise<string> {
    const rowTypeKey = keys['Row Type'] || 'Row Type';
    const statusKey = keys['Status'] || 'Status';
    const body = {
        parent: { database_id: databaseId },
        properties: {
            [titleProp]: {
                title: [{ type: 'text', text: { content: projectName } }]
            },
            [rowTypeKey]: { select: { name: 'Project' } },
            [statusKey]: { status: { name: 'Not Started' } }
        }
    };
    const result = await notionRequest(context, apiKey, 'pages', 'POST', body);
    return result.id;
}

// ==================== QUERY / CREATE REPO ====================

/**
 * Find repo row scoped to a project without filtering on the Project select.
 * Notion rejects queries like select.equals "A0" if "A0" is not yet an option on that property;
 * new option names are often created on write, not available for filter until added in UI/API.
 * Using Parent item (relation to project row) scopes correctly after step 1.
 */
async function queryRepoRow(
    context: any,
    apiKey: string,
    databaseId: string,
    repoName: string,
    projectRowId: string | null,
    keys: Record<string, string>
): Promise<string | null> {
    const k = (name: string) => keys[name] || name;
    const rowTypeKey = k('Row Type');
    const repoKey = k('Repo');
    const parentKey = keys['Parent item'];
    const filters: any[] = [
        { property: rowTypeKey, select: { equals: 'Repo' } },
        { property: repoKey, rich_text: { equals: repoName } }
    ];
    if (projectRowId && parentKey) {
        filters.push({ property: parentKey, relation: { contains: projectRowId } });
    }
    const body = {
        filter: { and: filters },
        page_size: 1
    };
    const result = await notionRequest(
        context,
        apiKey,
        `databases/${databaseId}/query`,
        'POST',
        body
    );
    if (result.results && result.results.length > 0) {
        return result.results[0].id;
    }
    // Legacy rows: repo under DB root without Parent item — match by repo full name only
    if (projectRowId && parentKey) {
        const loose = {
            filter: {
                and: [
                    { property: rowTypeKey, select: { equals: 'Repo' } },
                    { property: repoKey, rich_text: { equals: repoName } }
                ]
            },
            page_size: 1
        };
        const looseRes = await notionRequest(
            context,
            apiKey,
            `databases/${databaseId}/query`,
            'POST',
            loose
        );
        if (looseRes.results && looseRes.results.length > 0) {
            return looseRes.results[0].id;
        }
    }
    return null;
}

async function createRepoRow(
    context: any,
    apiKey: string,
    databaseId: string,
    repoName: string,
    repoLabel: string,
    projectName: string | null,
    titleProp: string,
    keys: Record<string, string>,
    projectRowId: string | null
): Promise<string> {
    const k = (name: string) => keys[name] || name;
    const now = new Date().toISOString().split('T')[0];
    const body = {
        parent: { database_id: databaseId },
        properties: {
            [titleProp]: {
                title: [{ type: 'text', text: { content: repoLabel } }]
            },
            [k('Row Type')]: { select: { name: 'Repo' } },
            [k('Repo')]: { rich_text: [{ type: 'text', text: { content: repoName } }] },
            [k('Status')]: { status: { name: 'Not Started' } },
            [k('Start Date')]: { date: { start: now } },
            [k('Last Activity')]: { date: { start: now } },
            [k('Activity Count 7d')]: { number: 0 },
            [k('Merged PRs')]: { number: 0 },
            [k('Open PRs')]: { number: 0 },
            [k('Risk Signal')]: { select: { name: 'On Track' } },
            ...(projectName ? { [k('Project')]: { select: { name: projectName } } } : {}),
            ...(projectRowId && keys['Parent item']
                ? { [k('Parent item')]: { relation: [{ id: projectRowId }] } }
                : {})
        }
    };
    const result = await notionRequest(context, apiKey, 'pages', 'POST', body);
    return result.id;
}

// ==================== QUERY / CREATE BRANCH ====================

async function queryBranchRow(
    context: any,
    apiKey: string,
    databaseId: string,
    repoName: string,
    branchName: string,
    keys: Record<string, string>
): Promise<string | null> {
    const rowTypeKey = keys['Row Type'] || 'Row Type';
    const repoKey = keys['Repo'] || 'Repo';
    const branchKey = keys['Branch'] || 'Branch';
    const body = {
        filter: {
            and: [
                { property: rowTypeKey, select: { equals: 'Branch' } },
                { property: repoKey, rich_text: { equals: repoName } },
                { property: branchKey, rich_text: { equals: branchName } }
            ]
        },
        page_size: 1
    };
    const result = await notionRequest(
        context,
        apiKey,
        `databases/${databaseId}/query`,
        'POST',
        body
    );
    if (result.results && result.results.length > 0) {
        return result.results[0].id;
    }
    return null;
}

async function createBranchRow(
    context: any,
    apiKey: string,
    databaseId: string,
    repoName: string,
    branchName: string,
    executionPageId: string | null,
    titleProp: string,
    keys: Record<string, string>,
    repoRowId: string,
    projectName: string | null
): Promise<string> {
    const k = (name: string) => keys[name] || name;
    const now = new Date().toISOString().split('T')[0];
    const props: any = {
        [titleProp]: {
            title: [{ type: 'text', text: { content: branchName } }]
        },
        [k('Row Type')]: { select: { name: 'Branch' } },
        [k('Repo')]: { rich_text: [{ type: 'text', text: { content: repoName } }] },
        [k('Branch')]: { rich_text: [{ type: 'text', text: { content: branchName } }] },
        [k('Last Activity')]: { date: { start: now } },
        [k('Start Date')]: { date: { start: now } },
        [k('Activity Count 7d')]: { number: 0 },
        ...(keys['Parent item']
            ? { [k('Parent item')]: { relation: [{ id: repoRowId }] } }
            : {}),
        ...(projectName ? { [k('Project')]: { select: { name: projectName } } } : {})
    };
    if (executionPageId) {
        const notionId = executionPageId.replace(/-/g, '');
        props[k('Execution log')] = { url: `https://www.notion.so/${notionId}` };
    }
    const body = {
        parent: { database_id: databaseId },
        properties: props
    };
    const result = await notionRequest(context, apiKey, 'pages', 'POST', body);
    return result.id;
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<MatchTaskOutput> {
    const input: MatchTaskInput = event.payload;
    const {
        repo,
        branch,
        repo_label,
        roadmap_database_id,
        notion_api_key,
        project_name,
        execution_page_id,
        title_property_name
    } = input;

    if (!roadmap_database_id) {
        context.log('No roadmap database ID configured; skipping match');
        return {
            matched: false,
            project_row_id: null,
            repo_row_id: null,
            branch_row_id: null,
            repo_name: repo,
            created: false
        };
    }

    const branchName = (branch || 'main').trim();
    context.log(`[task] match-task started: repo=${repo}, branch=${branchName}, database=${roadmap_database_id}`);
    context.log(`Looking up Project → Repo → Branch for "${repo}" / "${branchName}"`);

    try {
        const { titleKey: titleProp, keys } = await getDatabaseSchema(context, notion_api_key, roadmap_database_id);
        context.log(`[task] schema resolved: titleKey="${titleProp}", keys=${JSON.stringify(keys)}`);
        const projectName = (project_name || '').trim() || null;

        // ---- 1. Project (top-level) ----
        context.log(`[task] step 1: query project row (name=${projectName})`);
        let projectRowId = projectName
            ? await queryProjectRow(context, notion_api_key, roadmap_database_id, projectName, titleProp, keys)
            : null;
        context.log(`[task] step 1: project query result=${projectRowId}`);

        if (projectName && !projectRowId) {
            context.log(`[task] step 1: creating project row "${projectName}"`);
            projectRowId = await createProjectRow(
                context,
                notion_api_key,
                roadmap_database_id,
                projectName,
                titleProp,
                keys
            );
            context.log(`Created project row: ${projectRowId}`);
        }

        // ---- 2. Repo ----
        context.log(`[task] step 2: query repo row (repo=${repo}, projectRowId=${projectRowId || 'none'})`);
        let repoRowId = await queryRepoRow(
            context,
            notion_api_key,
            roadmap_database_id,
            repo,
            projectRowId,
            keys
        );
        context.log(`[task] step 2: repo query result=${repoRowId}`);

        if (!repoRowId) {
            const label = repo_label || repo.split('/').pop() || repo;
            context.log(`[task] step 2: creating repo row (label="${label}", parent=database_id:${roadmap_database_id})`);
            repoRowId = await createRepoRow(
                context,
                notion_api_key,
                roadmap_database_id,
                repo,
                label,
                projectName,
                titleProp,
                keys,
                projectRowId
            );
            context.log(`Created repo row: ${repoRowId}`);
        }

        // ---- 3. Branch (child of Repo) ----
        context.log(`[task] step 3: query branch row (repo=${repo}, branch=${branchName})`);
        let branchRowId = await queryBranchRow(
            context,
            notion_api_key,
            roadmap_database_id,
            repo,
            branchName,
            keys
        );
        context.log(`[task] step 3: branch query result=${branchRowId}`);

        if (!branchRowId) {
            context.log(`[task] step 3: creating branch row (branch="${branchName}", parent=database_id:${roadmap_database_id})`);
            branchRowId = await createBranchRow(
                context,
                notion_api_key,
                roadmap_database_id,
                repo,
                branchName,
                execution_page_id,
                titleProp,
                keys,
                repoRowId,
                projectName
            );
            context.log(`Created branch row: ${branchRowId}`);
        }

        context.log(`[task] match-task complete: project=${projectRowId}, repo=${repoRowId}, branch=${branchRowId}`);
        return {
            matched: true,
            project_row_id: projectRowId,
            repo_row_id: repoRowId,
            branch_row_id: branchRowId,
            repo_name: repo,
            created: !!branchRowId
        };
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR non-fatal] match-task: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        return {
            matched: false,
            project_row_id: null,
            repo_row_id: null,
            branch_row_id: null,
            repo_name: repo,
            created: false,
            error: msg
        };
    }
}
