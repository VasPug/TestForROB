// setup.ts — Setup engagement: creates the roadmap database (one-time or on demand).
// Triggered by events with event_type ROADMAP_SETUP_REQUEST. Extracted from the main concierge
// so DB creation is a dedicated, separately triggerable flow.
// Saves resulting database ID to Cubby so concierge can look it up at runtime.
// V8 isolate: fully inline, no imports.

//@ts-nocheck

const CUBBY_NAME = 'executionLogCubby';

// ==================== TYPES ====================

interface SetupPayload {
    event_type?: string;
    parent_page_id: string;
    roadmap_name: string;
    notion_api_key: string;
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<any> {
    const payload = event.payload || {};
    const { parent_page_id, roadmap_name, notion_api_key } = payload as SetupPayload;

    context.log(`[setup] Engagement started: roadmap_name=${roadmap_name || 'n/a'}, parent_page_id=${parent_page_id ? 'set' : 'missing'}`);

    if (!parent_page_id || !roadmap_name || !notion_api_key) {
        context.log('[setup] Validation failed: missing parent_page_id, roadmap_name, or notion_api_key');
        return {
            ok: false,
            error: 'missing_required_fields',
            message: 'Required: parent_page_id, roadmap_name, notion_api_key'
        };
    }

    try {
        const result = await context.agents.roadmapAgent.setupDatabase({
            parent_page_id,
            roadmap_name,
            notion_api_key
        });

        context.log(`[setup] Complete: database_id=${result.database_id}, created=${result.created}`);
        if (result.warnings && result.warnings.length > 0) {
            context.log(`[setup] Warnings: ${result.warnings.join('; ')}`);
        }

        // Persist roadmap DB ID to Cubby so concierge can look it up without hardcoded values
        const cubby = context.cubby(CUBBY_NAME);
        const existingConfig = (await cubby.json.exists('mapping/config'))
            ? await cubby.json.get('mapping/config')
            : {};
        await cubby.json.set('mapping/config', {
            ...existingConfig,
            roadmap_database_id: result.database_id
        });
        context.log('[setup] Cubby mapping/config updated with roadmap_database_id');

        return {
            ok: true,
            database_id: result.database_id,
            project_row_id: result.project_row_id,
            created: result.created,
            warnings: result.warnings || []
        };
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR] setup engagement: ${msg}`);
        if (err?.stack) context.log(`[ERROR] setup stack: ${err.stack}`);
        return {
            ok: false,
            error: 'setup_failed',
            message: msg
        };
    }
}
