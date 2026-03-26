// wiki-scanner.ts — Fetches a Notion spec page, splits by H2, and uses LLM
// per-section to identify what a merged PR makes stale.
// Returns a structured list for the wiki writer to apply as block comments.

//@ts-nocheck

const INFERENCE_URL = 'https://compute-5.devnet.ddc-dragon.com/inference/api/v1/inference';
const LLM_MODEL = { bucket: 1338, name: 'qwen2-vl-7b-instruct', version: 'v1.0.0' };

// ==================== TYPES ====================

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

interface WikiScanInput {
    notion_api_key: string;
    spec_page_id: string;
    pr_title: string;
    pr_url: string;
    pr_number: number;
    pr_body: string;
    files: PRFile[];
    commits: PRCommit[];
    repo_tree: string[];
    pr_change_summary: string;
}

interface SectionInstruction {
    heading: string;
    block_id: string | null;
    last_edited_by: string | null;
    type: 'needs_review';
    stale_sentence?: string;
    why?: string;
    suggested_fix?: string;
}

interface AffectedPage {
    page_id: string;
    page_title: string;
    sections: SectionInstruction[];
}

interface WikiScanOutput {
    pages: AffectedPage[];
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

function extractPlainText(richTextArray: any[]): string {
    return (richTextArray || [])
        .map((item: any) => item.plain_text || item.text?.content || '')
        .join('');
}

async function fetchBlockChildren(context: any, apiKey: string, blockId: string): Promise<any[]> {
    const blocks: any[] = [];
    let cursor: string | undefined;
    do {
        const path = cursor
            ? `blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
            : `blocks/${blockId}/children?page_size=100`;
        const result = await notionRequest(context, apiKey, path);
        blocks.push(...(result.results || []));
        cursor = result.has_more ? result.next_cursor : undefined;
    } while (cursor);
    return blocks;
}

// ==================== SPEC PAGE SECTION SPLITTING ====================

interface PageSection {
    heading: string;
    blockId: string | null;
    lastEditedBy: string | null;
    content: string;
}

function splitIntoSections(blocks: any[]): PageSection[] {
    const sections: PageSection[] = [];
    const HEADING_TYPES = new Set(['heading_2']);

    let currentHeading = '(intro)';
    let currentBlockId: string | null = null;
    let currentEditedBy: string | null = null;
    let currentLines: string[] = [];

    for (const block of blocks) {
        const type = block.type;
        const content = block[type];
        if (!content) continue;

        if (HEADING_TYPES.has(type)) {
            if (currentLines.length > 0) {
                sections.push({ heading: currentHeading, blockId: currentBlockId, lastEditedBy: currentEditedBy, content: currentLines.join('\n') });
            }
            currentHeading = extractPlainText(content.rich_text || []) || type;
            currentBlockId = block.id;
            currentEditedBy = block.last_edited_by?.id || null;
            currentLines = [];
        } else if (content.rich_text) {
            const text = extractPlainText(content.rich_text);
            if (text.trim()) currentLines.push(text);
        }
    }

    if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, blockId: currentBlockId, lastEditedBy: currentEditedBy, content: currentLines.join('\n') });
    }

    if (sections.length === 0) {
        const allLines: string[] = [];
        for (const block of blocks) {
            const type = block.type;
            const content = block[type];
            if (content?.rich_text) {
                const text = extractPlainText(content.rich_text);
                if (text.trim()) allLines.push(text);
            }
        }
        sections.push({ heading: '(full page)', blockId: null, lastEditedBy: null, content: allLines.join('\n') });
    }

    return sections;
}

// ==================== ARCHITECTURE CONTEXT ====================

function buildArchContext(repoTree: string[]): string {
    if (!repoTree || repoTree.length === 0) return '(no project structure available)';

    const sorted = repoTree.slice().sort();
    const tree: string[] = [];
    const seenDirs = new Set<string>();
    for (const filePath of sorted) {
        const parts = filePath.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const segment = parts.slice(0, i).join('/');
            const isFile = i === parts.length;
            if (!isFile) {
                if (!seenDirs.has(segment)) {
                    seenDirs.add(segment);
                    tree.push('  '.repeat(i - 1) + parts[i - 1] + '/');
                }
            } else {
                tree.push('  '.repeat(i - 1) + parts[i - 1]);
            }
        }
    }

    return `PROJECT STRUCTURE:\n${tree.join('\n')}`;
}

// ==================== LLM CLASSIFICATION ====================

function buildDiffSummary(files: PRFile[], commits: PRCommit[]): string {
    const fileLines = (files || []).slice(0, 15).map(f =>
        `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})${f.patch ? '\n' + f.patch.slice(0, 600) : ''}`
    ).join('\n');

    const commitLines = (commits || []).slice(0, 8).map(c =>
        `  ${c.sha.slice(0, 7)} — ${c.message.split('\n')[0]}`
    ).join('\n');

    return `FILES CHANGED:\n${fileLines || 'none'}\n\nCOMMITS:\n${commitLines || 'none'}`;
}

function buildChangeSummaryPrompt(
    archContext: string,
    prTitle: string,
    prBody: string,
    diffSummary: string,
    prChangeSummary: string,
    specSectionHeadings: string[]
): string {
    const specSectionBlock =
        specSectionHeadings.length > 0
            ? `
## SPEC SECTIONS (focus your summary on these)
The wiki spec has these sections. Emphasize changes that could affect or relate to them.
${specSectionHeadings.map(h => `- ${h}`).join('\n')}
`
            : '';

    return `Summarize a code change. Be specific about what files changed and what the change does.
${specSectionBlock}
## PR
Title: ${prTitle}
Description: ${prBody || '(no description)'}

## CODE CHANGES (ground truth — use this as your primary source)
${diffSummary}
${prChangeSummary ? `
## PRIOR ANALYSIS (for reference — may be incomplete, defer to code changes above)
${prChangeSummary}
` : ''}
## PROJECT STRUCTURE
${archContext}

## INSTRUCTIONS
Write a factual summary based on the CODE CHANGES section. Reference specific file names and what was added, changed, or removed.
Focus on changes that might affect the spec sections listed above. Be concrete — no vague phrases like "test new architecture" or "no specific changes".

Respond in this format:
SUMMARY: 2-4 sentences. Name the files that changed and what each change does. Tie changes to relevant spec topics where possible.
KEY_CHANGES:
- <file path>: <what changed>
- <file path>: <what changed>`;
}

function parseChangeSummary(responseText: string): string {
    if (!responseText || responseText.trim().length === 0) return '';
    return responseText.trim();
}

function buildSectionPrompt(
    changeSummary: string,
    sectionHeading: string,
    sectionContent: string
): string {
    return `Compare a wiki section against a code change and decide if the section is outdated.

## WIKI SECTION
Section: ${sectionHeading}
Content:
${sectionContent || '(empty)'}

## WHAT CHANGED IN THE CODE
${changeSummary}

## RULES
1. Read the wiki section carefully. Read the change summary carefully.
2. Find a specific sentence or phrase in the wiki section that is now wrong, outdated, or missing important context because of the code change.
3. A sentence counts as stale if: it states something the code change contradicts, OR it describes a process/flow that now has additional steps or different behavior, OR it omits something the code change added that readers would need to know.
4. If you CANNOT find any stale sentence, respond exactly: AFFECTED: NONE
5. If you CAN find a stale sentence, respond in the format below.

Do NOT flag a section just because the topic is vaguely related. You must point to a specific sentence.

## EXAMPLE 1 (factual error)
STALE_SENTENCE: "The service runs on port 3000"
WHY: PR changed the default port to 8080 in server.ts
SUGGESTED_FIX: Update to say the service runs on port 8080

## EXAMPLE 2 (missing information)
STALE_SENTENCE: "Events are validated and then stored in the database"
WHY: PR added a deduplication step between validation and storage in pipeline.ts
SUGGESTED_FIX: Add that events are deduplicated after validation before being stored

## RESPONSE FORMAT (only if affected)
STALE_SENTENCE: <copy the exact sentence from the wiki that is wrong or incomplete>
WHY: <one sentence: what the code change did that makes it stale>
SUGGESTED_FIX: <one sentence: what the wiki should say instead>`;
}

interface ParsedResult {
    stale_sentence?: string;
    why?: string;
    suggested_fix?: string;
}

function parseSectionResponse(responseText: string): ParsedResult | null {
    if (/AFFECTED:\s*NONE/i.test(responseText)) return null;

    const sentenceMatch = responseText.match(/STALE_SENTENCE:\s*([\s\S]+?)(?=\nWHY:|\nSUGGESTED_FIX:|$)/i);
    const whyMatch = responseText.match(/WHY:\s*([\s\S]+?)(?=\nSUGGESTED_FIX:|$)/i);
    const fixMatch = responseText.match(/SUGGESTED_FIX:\s*([\s\S]+?)$/i);

    if (!sentenceMatch) return null;

    return {
        stale_sentence: sentenceMatch[1].trim(),
        why: whyMatch ? whyMatch[1].trim() : undefined,
        suggested_fix: fixMatch ? fixMatch[1].trim() : undefined
    };
}

// ==================== HANDLE ====================

async function callLLM(context: any, prompt: string, maxTokens: number = 600): Promise<string> {
    const response = await context.fetch(INFERENCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: LLM_MODEL,
            input: { prompt, max_tokens: maxTokens, temperature: 0.2 }
        })
    });

    if (!response.ok) {
        throw new Error(`LLM call failed: ${response.statusText}: ${await response.text()}`);
    }

    const data = await response.json();
    const rawOutput = data.output?.text || data.output || '';
    return typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
}

async function handle(event: any, context: any): Promise<WikiScanOutput> {
    const input: WikiScanInput = event.payload;

    context.log(`[task] wiki-scanner started: spec_page_id=${input.spec_page_id}, pr=${input.pr_number}`);
    context.log(`Scanning spec page ${input.spec_page_id} for PR #${input.pr_number}`);

    const archContext = buildArchContext(input.repo_tree || []);
    context.log(`Architecture context: ${archContext.length} chars`);

    // Step 1: Fetch spec page and split into H2 sections
    let sections: PageSection[] = [];
    try {
        const blocks = await fetchBlockChildren(context, input.notion_api_key, input.spec_page_id);
        sections = splitIntoSections(blocks);
        context.log(`Spec page has ${sections.length} sections: ${sections.map(s => s.heading).join(', ')}`);
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR non-fatal] wiki-scanner fetch spec page: ${msg}`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        return { pages: [] };
    }

    const specSectionHeadings = sections.map(s => s.heading);

    // Step 2: Build change summary (1 LLM call), focused on spec section topics
    const diffSummary = buildDiffSummary(input.files || [], input.commits || []);
    const summaryPrompt = buildChangeSummaryPrompt(
        archContext,
        input.pr_title,
        input.pr_body,
        diffSummary,
        input.pr_change_summary || '',
        specSectionHeadings
    );

    let changeSummary = '';
    try {
        const summaryResponse = await callLLM(context, summaryPrompt, 800);
        changeSummary = parseChangeSummary(summaryResponse);
        context.log(`Change summary (${changeSummary.length} chars): ${changeSummary.slice(0, 200)}...`);
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        context.log(`[ERROR non-fatal] wiki-scanner change summary LLM: ${msg} — falling back to raw diff`);
        if (err?.stack) context.log(`[ERROR] stack: ${err.stack}`);
        changeSummary = `SUMMARY: ${input.pr_change_summary || input.pr_title}\n\nRAW CHANGES:\n${diffSummary}`;
    }

    // Step 3: Per-section comparison (parallel)
    const sectionResults = await Promise.allSettled(sections.map(async (section) => {
        const prompt = buildSectionPrompt(
            changeSummary,
            section.heading,
            section.content
        );
        const responseText = await callLLM(context, prompt, 900);
        context.log(`Section "${section.heading}" response (${responseText.length} chars)`);
        const parsed = parseSectionResponse(responseText);
        if (!parsed) return null;
        return { section, parsed };
    }));

    const sectionInstructions: SectionInstruction[] = [];

    for (let i = 0; i < sectionResults.length; i++) {
        const result = sectionResults[i];
        if (result.status === 'fulfilled' && result.value) {
            const { section, parsed } = result.value;
            sectionInstructions.push({
                heading: section.heading,
                block_id: section.blockId,
                last_edited_by: section.lastEditedBy,
                type: 'needs_review',
                stale_sentence: parsed.stale_sentence,
                why: parsed.why,
                suggested_fix: parsed.suggested_fix
            });
        } else if (result.status === 'rejected') {
            const reason = result.reason ?? {};
            const msg = reason?.message ?? String(result.reason);
            context.log(`[ERROR non-fatal] wiki-scanner section "${sections[i].heading}" LLM: ${msg}`);
            if (reason?.stack) context.log(`[ERROR] stack: ${reason.stack}`);
        }
    }

    context.log(`Parsed ${sectionInstructions.length} section instructions from spec page`);

    const pages: AffectedPage[] = sectionInstructions.length > 0
        ? [{ page_id: input.spec_page_id, page_title: 'Spec', sections: sectionInstructions }]
        : [];

    context.log(`${pages.length} pages affected, ${sectionInstructions.length} sections flagged`);
    context.log(`[task] wiki-scanner complete`);

    return { pages };
}
