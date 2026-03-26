// ping-reviewer.ts — Posts a review request message to a Slack channel via bot.
// @mentions the reviewer and includes the PR link.
// Graceful no-op if slack_bot_token is not configured.

//@ts-nocheck

// ==================== TYPES ====================

interface PingReviewerInput {
    slack_productivity_bot_token: string;
    slack_channel_id: string;
    reviewer_slack_user_id: string | null;  // Slack member ID e.g. U012AB3CD (preferred for @mention)
    reviewer_slack_handle: string;           // fallback display name
    pr_title: string;
    pr_url: string;
    pr_number: number;
    repo: string;
    author: string;
}

interface PingReviewerOutput {
    sent: boolean;
    ts?: string;  // Slack message timestamp, useful for threading later
}

// ==================== HANDLE ====================

async function handle(event: any, context: any): Promise<PingReviewerOutput> {
    const input: PingReviewerInput = event.payload;

    if (!input.slack_productivity_bot_token) {
        context.log('slack_productivity_bot_token not configured — skipping Slack ping');
        return { sent: false };
    }

    if (!input.slack_channel_id) {
        context.log('slack_channel_id not configured — skipping Slack ping');
        return { sent: false };
    }

    // Use member ID for proper @mention if available, else plain handle text
    const mention = input.reviewer_slack_user_id
        ? `<@${input.reviewer_slack_user_id}>`
        : `@${input.reviewer_slack_handle}`;

    const text = `${mention} Review requested on PR #${input.pr_number}: *${input.pr_title}*\n${input.pr_url}`;

    context.log(`Posting review ping for PR #${input.pr_number} to channel ${input.slack_channel_id}`);

    const response = await context.fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${input.slack_productivity_bot_token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            channel: input.slack_channel_id,
            text
        })
    });

    const data = await response.json();

    if (!data.ok) {
        throw new Error(`Slack API error: ${data.error}`);
    }

    context.log(`Slack message sent (ts: ${data.ts})`);

    return { sent: true, ts: data.ts };
}
