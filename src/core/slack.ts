// Slack via plain HTTP: chat.postMessage / chat.update + request signature verification.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

type Block = Record<string, unknown>;

async function slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slack.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as Record<string, any>;
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? res.status}`);
  return data;
}

/** Verifies X-Slack-Signature (HMAC-SHA256 of "v0:<timestamp>:<raw body>") and rejects requests older than 5 minutes. */
export function verifySlackSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const expected = 'v0=' + createHmac('sha256', config.slack.signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verifies a Slack interactivity request and returns its parsed payload, or null if invalid. */
export function parseSlackInteraction(rawBody: string, timestamp: string | undefined, signature: string | undefined): Record<string, any> | null {
  if (!verifySlackSignature(rawBody, timestamp, signature)) return null;
  try {
    return JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '');
  } catch {
    return null;
  }
}

// ---------- Message formatting ----------

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 15) + '\n…(truncated)' : s);

/** Renders inputs as "key: value" lines; nested objects/arrays as compact JSON. */
export function formatFields(obj: Record<string, unknown>): string {
  const lines = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `*${k}:* ${typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : String(v)}`);
  return truncate(lines.join('\n') || '_no inputs_', 2900);
}

export interface ApprovalMessage {
  requestId: string;
  agent: string;
  title: string; // e.g. "create_customer"
  body: string; // mrkdwn details
}

function approvalBlocks(m: ApprovalMessage): Block[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: `Approval needed: ${m.title}`.slice(0, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: `Agent *${m.agent}* wants to run *${m.title}* in Housecall Pro.` } },
    { type: 'section', text: { type: 'mrkdwn', text: m.body } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Request \`${m.requestId}\`` }] },
  ];
}

/** Posts the approval request with Approve/Reject buttons. Returns the message ts. */
export async function postApprovalMessage(m: ApprovalMessage): Promise<string> {
  const data = await slackApi('chat.postMessage', {
    channel: config.slack.channelId,
    text: `Approval needed: ${m.title} (requested by ${m.agent})`,
    blocks: [
      ...approvalBlocks(m),
      {
        type: 'actions',
        block_id: 'approval',
        elements: [
          { type: 'button', action_id: 'approve', style: 'primary', value: m.requestId, text: { type: 'plain_text', text: 'Approve' } },
          { type: 'button', action_id: 'reject', style: 'danger', value: m.requestId, text: { type: 'plain_text', text: 'Reject' } },
        ],
      },
    ],
  });
  return data.ts as string;
}

/** Replaces the buttons with the final outcome. Reuses the original blocks (from the click payload) when available. */
export async function updateApprovalMessage(ts: string, m: ApprovalMessage, outcome: string, originalBlocks?: Block[]): Promise<void> {
  const base = originalBlocks?.length ? originalBlocks.filter((b) => b.type !== 'actions') : approvalBlocks(m);
  await slackApi('chat.update', {
    channel: config.slack.channelId,
    ts,
    text: `${m.title}: ${outcome}`,
    blocks: [...base, { type: 'section', text: { type: 'mrkdwn', text: truncate(outcome, 2900) } }],
  });
}

/** Posts a plain alert to the approvals channel (e.g. an approved action that failed). Never throws. */
export async function postAlert(text: string): Promise<void> {
  try {
    await slackApi('chat.postMessage', { channel: config.slack.channelId, text: truncate(`:rotating_light: ${text}`, 3000) });
  } catch (err) {
    console.error(`Slack alert failed: ${(err as Error).message}`);
  }
}

/** Replies only to the clicking user (via the interaction's response_url). Never throws. */
export async function replyEphemeral(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    });
  } catch (err) {
    console.error(`Slack ephemeral reply failed: ${(err as Error).message}`);
  }
}
