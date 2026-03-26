// concierge.ts - Execution Log Updater
// Receives PR events from GitHub Actions, uses LLM to decide what to log,
// then writes execution log entries to Notion via sub-agents.

//@ts-nocheck

const CUBBY_NAME = 'executionLog';

// ==================== LOGGING ====================

const uuid = (): string => {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

type LogEvent = 'START' | 'DATA' | 'END' | 'ERROR' | 'DECISION' | 'INFO';

type LogExtra = {
    input?: Record<string, any>;
    output?: Record<string, any>;
    query?: {
        type?: 'get' | 'set' | string;
        key?: string;
        value?: string;
    };
};

function formatLog(
    component: string,
    callId: string,
    cid: string,
    eventName: LogEvent,
    description: string,
    parentId?: string,
    extra?: LogExtra,
    operation?: string
): string {
    const message: any = {
        callId,
        parentId: parentId ?? null,
        cid,
        component,
        event: eventName,
        description
    };
    message.operation = operation ?? null;

    if (extra?.input !== undefined) message.input = extra.input;
    if (extra?.output !== undefined) message.output = extra.output;
    if (extra?.query !== undefined) message.query = extra.query;

    return JSON.stringify(message);
}

// ==================== TYPES ====================

interface PREventPayload {
    event_type: string;
    action: string | null;
    merged: boolean;
    pr_number: number;
    pr_title: string;
    pr_url: string;
    pr_body: string;
    repo: string;
    author: string | null;
    merged_by: string | null;
    merged_at: string | null;
    base_branch: string | null;
    timestamp: string;
    notion_page_id: string | null;
    notion_api_key: string | null;
    delivery_id: string | null;
    files: PRFile[] | null;
    commits: PRCommit[] | null;
}

interface PRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
}

interface PRCommit {
    sha: string;
    message: string;
}

interface LLMDecision {
    should_write: boolean;
    entry_text: string;
    category: string;
}

interface NotionPageState {
    blocks: any[];
    toggles: { id: string; title: string }[];
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<any> {
    const p: PREventPayload = event.payload || {};
    const cid = p.delivery_id || uuid();
    const startCallId = uuid();

    context.log(formatLog(
        'concierge',
        startCallId,
        cid,
        'START',
        `Processing PR #${p.pr_number} (${p.action}) from ${p.repo}`,
        null,
        {
            input: {
                pr_number: p.pr_number,
                action: p.action,
                merged: p.merged,
                repo: p.repo,
                author: p.author,
                files_count: p.files?.length ?? 0,
                commits_count: p.commits?.length ?? 0
            }
        }
    ));

    // ---- Validate required fields ----
    if (!p.pr_number || !p.pr_title || !p.pr_url) {
        context.log(formatLog(
            'concierge',
            startCallId,
            cid,
            'ERROR',
            'Missing required PR fields (pr_number, pr_title, or pr_url)',
            null,
            { input: { pr_number: p.pr_number, pr_title: p.pr_title, pr_url: p.pr_url } }
        ));
        return { skipped: true, reason: 'missing_required_fields' };
    }

    const notionPageId = p.notion_page_id;
    if (!notionPageId) {
        context.log(formatLog(
            'concierge',
            startCallId,
            cid,
            'ERROR',
            'Missing notion_page_id in payload',
            null
        ));
        return { skipped: true, reason: 'missing_notion_page_id' };
    }

    const notionApiKey = p.notion_api_key;
    if (!notionApiKey) {
        context.log(formatLog(
            'concierge',
            startCallId,
            cid,
            'ERROR',
            'Missing notion_api_key in payload',
            null
        ));
        return { skipped: true, reason: 'missing_notion_api_key' };
    }

    // ---- Step 1: Read current Notion page state ----
    const readPageCallId = uuid();
    let pageState: NotionPageState;
    try {
        context.log(formatLog(
            'notionAgent',
            readPageCallId,
            cid,
            'START',
            `Reading current Notion page ${notionPageId}`,
            startCallId,
            { input: { notion_page_id: notionPageId } },
            'readPage'
        ));

        pageState = await context.agents.notionAgent.readPage({
            notion_page_id: notionPageId,
            notion_api_key: notionApiKey,
            cid,
            callId: readPageCallId
        });

        context.log(formatLog(
            'notionAgent',
            readPageCallId,
            cid,
            'END',
            `Read ${pageState.blocks?.length ?? 0} blocks, found ${pageState.toggles?.length ?? 0} weekly toggles`,
            startCallId,
            {
                output: {
                    block_count: pageState.blocks?.length ?? 0,
                    toggle_count: pageState.toggles?.length ?? 0
                }
            },
            'readPage'
        ));
    } catch (error) {
        context.log(formatLog(
            'notionAgent',
            readPageCallId,
            cid,
            'ERROR',
            `Failed to read Notion page: ${error.message}`,
            startCallId,
            {},
            'readPage'
        ));
        return { ok: false, error: error.message, step: 'readPage' };
    }

    // ---- Step 2: Ask LLM to decide what to log ----
    const llmCallId = uuid();
    let decision: LLMDecision;
    try {
        context.log(formatLog(
            'llmDecisionAgent',
            llmCallId,
            cid,
            'START',
            `Asking LLM to analyze PR #${p.pr_number} and decide execution log entry`,
            readPageCallId,
            {
                input: {
                    pr_number: p.pr_number,
                    action: p.action,
                    files_count: p.files?.length ?? 0,
                    commits_count: p.commits?.length ?? 0,
                    existing_toggles: pageState.toggles?.length ?? 0
                }
            },
            'decide'
        ));

        decision = await context.agents.llmDecisionAgent.decide({
            pr_data: {
                action: p.action,
                merged: p.merged,
                pr_number: p.pr_number,
                pr_title: p.pr_title,
                pr_url: p.pr_url,
                pr_body: p.pr_body,
                repo: p.repo,
                author: p.author,
                merged_by: p.merged_by,
                merged_at: p.merged_at,
                base_branch: p.base_branch,
                files: p.files,
                commits: p.commits
            },
            page_state: pageState,
            cid,
            callId: llmCallId
        });

        context.log(formatLog(
            'llmDecisionAgent',
            llmCallId,
            cid,
            'DECISION',
            `LLM decided: should_write=${decision.should_write}, category=${decision.category}`,
            readPageCallId,
            {
                output: {
                    should_write: decision.should_write,
                    category: decision.category,
                    entry_text_length: decision.entry_text?.length ?? 0
                }
            },
            'decide'
        ));
    } catch (error) {
        context.log(formatLog(
            'llmDecisionAgent',
            llmCallId,
            cid,
            'ERROR',
            `LLM decision failed: ${error.message}`,
            readPageCallId,
            {},
            'decide'
        ));
        return { ok: false, error: error.message, step: 'llmDecision' };
    }

    // ---- Step 3: Write to Notion if LLM says so ----
    if (!decision.should_write) {
        context.log(formatLog(
            'concierge',
            uuid(),
            cid,
            'END',
            `Skipping write for PR #${p.pr_number} — LLM decided not to log`,
            llmCallId
        ));
        return { ok: true, skipped: true, reason: 'llm_skip', pr: p.pr_number };
    }

    const writeCallId = uuid();
    try {
        const eventDate = p.merged_at || p.timestamp || new Date().toISOString();

        context.log(formatLog(
            'notionAgent',
            writeCallId,
            cid,
            'START',
            `Writing execution log entry for PR #${p.pr_number}`,
            llmCallId,
            {
                input: {
                    notion_page_id: notionPageId,
                    pr_number: p.pr_number,
                    category: decision.category,
                    entry_text_length: decision.entry_text.length,
                    date: eventDate
                }
            },
            'writeEntry'
        ));

        const writeResult = await context.agents.notionAgent.writeEntry({
            notion_page_id: notionPageId,
            notion_api_key: notionApiKey,
            entry_text: decision.entry_text,
            category: decision.category,
            pr_url: p.pr_url,
            pr_number: p.pr_number,
            action: p.action,
            merged: p.merged,
            author: p.author,
            merged_by: p.merged_by,
            event_date: eventDate,
            cid,
            callId: writeCallId
        });

        context.log(formatLog(
            'notionAgent',
            writeCallId,
            cid,
            'END',
            `Wrote entry under toggle ${writeResult.toggle_id} (${writeResult.week})`,
            llmCallId,
            {
                output: {
                    toggle_id: writeResult.toggle_id,
                    week: writeResult.week
                }
            },
            'writeEntry'
        ));
    } catch (error) {
        context.log(formatLog(
            'notionAgent',
            writeCallId,
            cid,
            'ERROR',
            `Failed to write Notion entry: ${error.message}`,
            llmCallId,
            {},
            'writeEntry'
        ));
        return { ok: false, error: error.message, step: 'writeEntry' };
    }

    // ---- Done ----
    context.log(formatLog(
        'concierge',
        uuid(),
        cid,
        'END',
        `Finished processing PR #${p.pr_number} (${p.action}) — entry logged`,
        startCallId
    ));

    return {
        ok: true,
        pr: p.pr_number,
        action: p.action,
        category: decision.category,
        logged: true
    };
}
