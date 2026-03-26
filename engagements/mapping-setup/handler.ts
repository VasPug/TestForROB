// setup-mapping.ts — Creates the User Mapping and Repo Mapping Notion databases.
// Triggered by events with event_type MAPPING_SETUP_REQUEST.
// Saves resulting database IDs to Cubby so concierge can look them up at runtime.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

const CUBBY_NAME = 'executionLogCubby';

// ==================== TYPES ====================

interface SetupMappingPayload {
    event_type?: string;
    parent_page_id: string;
    notion_api_key: string;
    ai_section_block_id?: string;
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<any> {
    const payload = event.payload || {};
    const { parent_page_id, notion_api_key, ai_section_block_id } = payload as SetupMappingPayload;

    context.log(`[setup-mapping] Engagement started: parent_page_id=${parent_page_id ? 'set' : 'missing'}`);

    if (!parent_page_id || !notion_api_key) {
        context.log('[setup-mapping] Validation failed: missing parent_page_id or notion_api_key');
        return {
            ok: false,
            error: 'missing_required_fields',
            message: 'Required: parent_page_id, notion_api_key'
        };
    }

    const warnings: string[] = [];

    try {
        const userResult = await context.agents.notionAgent.setupUserMapping({
            parent_page_id,
            notion_api_key
        });

        context.log(`[setup-mapping] User Mapping: database_id=${userResult.database_id}, created=${userResult.created}`);
        if (userResult.warnings?.length > 0) warnings.push(...userResult.warnings);

        const repoResult = await context.agents.notionAgent.setupRepoMapping({
            parent_page_id,
            notion_api_key
        });

        context.log(`[setup-mapping] Repo Mapping: database_id=${repoResult.database_id}, created=${repoResult.created}`);
        if (repoResult.warnings?.length > 0) warnings.push(...repoResult.warnings);

        // Persist DB IDs to Cubby so concierge can look them up without hardcoded values
        const cubby = context.cubby(CUBBY_NAME);
        const existingConfig = (await cubby.json.exists('mapping/config'))
            ? await cubby.json.get('mapping/config')
            : {};
        await cubby.json.set('mapping/config', {
            ...existingConfig,
            user_mapping_db_id: userResult.database_id,
            repo_mapping_db_id: repoResult.database_id,
            ...(ai_section_block_id ? { ai_section_block_id } : {})
        });
        context.log('[setup-mapping] Cubby mapping/config updated with user and repo DB IDs');

        if (warnings.length > 0) {
            context.log(`[setup-mapping] Warnings: ${warnings.join('; ')}`);
        }

        return {
            ok: true,
            user_mapping: {
                database_id: userResult.database_id,
                created: userResult.created
            },
            repo_mapping: {
                database_id: repoResult.database_id,
                created: repoResult.created
            },
            ai_section_block_id: ai_section_block_id || null,
            warnings
        };
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR] setup-mapping engagement: ${msg}`);
        if (err?.stack) context.log(`[ERROR] setup-mapping stack: ${err.stack}`);
        return {
            ok: false,
            error: 'setup_failed',
            message: msg
        };
    }
}
