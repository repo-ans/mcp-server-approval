// Human-in-the-loop gate: write actions are queued in approval_requests, posted to Slack,
// and only executed when someone clicks Approve.
import { config } from '../config.js';
import { db } from './db.js';
import { logToolCall } from './logger.js';
import { formatFields, postAlert, postApprovalMessage, replyEphemeral, updateApprovalMessage, type ApprovalMessage } from './slack.js';

type Inputs = Record<string, unknown>;

interface Action {
  run: (inputs: Inputs, ctx: { agent: string }) => Promise<unknown>;
  /** Optional custom Slack summary of the inputs (mrkdwn). Defaults to a key/value list. */
  describe?: (inputs: Inputs) => string;
}

const actions = new Map<string, Action>();

/** Registers something that can be approved: a write tool or a multi-step workflow. */
export function registerAction(name: string, action: Action): void {
  actions.set(name, action);
}

function message(id: string, agent: string, name: string, inputs: Inputs): ApprovalMessage {
  const describe = actions.get(name)?.describe ?? formatFields;
  return { requestId: id, agent, title: name, body: describe(inputs) };
}

/** Queues an action and posts it to Slack. Returns the approval request id. Throws if it could not be submitted. */
export async function submitForApproval(agent: string, name: string, inputs: Inputs): Promise<string> {
  if (!actions.has(name)) throw new Error(`No approvable action named "${name}"`);

  const { data, error } = await db.from('approval_requests').insert({ agent, tool: name, inputs }).select('id').single();
  if (error) throw new Error(`Could not queue approval request: ${error.message}`);
  const id = data.id as string;

  try {
    const ts = await postApprovalMessage(message(id, agent, name, inputs));
    await db.from('approval_requests').update({ slack_ts: ts }).eq('id', id);
  } catch (err) {
    const reason = (err as Error).message;
    await db.from('approval_requests').update({ status: 'failed', result: { error: reason } }).eq('id', id);
    throw new Error(`Could not post the approval request to Slack (${reason}). Nothing was submitted.`);
  }
  return id;
}

const summarize = (result: unknown) => {
  const json = JSON.stringify(result, null, 1);
  return json.length > 1200 ? json.slice(0, 1200) + '…' : json;
};

export type DecisionOutcome = 'done' | 'already_decided' | 'not_found';

/**
 * Applies a Slack decision. The pending -> approved/rejected transition is a single conditional UPDATE,
 * so double clicks and concurrent clicks can only ever execute the action once.
 */
export async function decide(id: string, approve: boolean, decidedBy: string, originalBlocks?: Record<string, unknown>[]): Promise<{ outcome: DecisionOutcome; status?: string }> {
  const { data: row, error } = await db
    .from('approval_requests')
    .update({ status: approve ? 'approved' : 'rejected', decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error || !row) {
    const { data: existing } = await db.from('approval_requests').select('status').eq('id', id).maybeSingle();
    return existing ? { outcome: 'already_decided', status: existing.status } : { outcome: 'not_found' };
  }

  const msg = message(row.id, row.agent, row.tool, row.inputs);

  if (!approve) {
    await logToolCall({ agent: row.agent, tool: row.tool, inputs: row.inputs, result: { decided_by: decidedBy }, status: 'rejected', latency_ms: 0 });
    if (row.slack_ts) await updateApprovalMessage(row.slack_ts, msg, `:x: *Rejected* by ${decidedBy}. Nothing was changed in Housecall Pro.`, originalBlocks);
    return { outcome: 'done' };
  }

  const start = Date.now();
  const action = actions.get(row.tool);
  try {
    if (!action) throw new Error(`Action "${row.tool}" is no longer registered on this server`);
    const result = await action.run(row.inputs, { agent: row.agent });
    await db.from('approval_requests').update({ result }).eq('id', id);
    await logToolCall({ agent: row.agent, tool: row.tool, inputs: row.inputs, result, status: 'approved', latency_ms: Date.now() - start });
    const mode = config.hcp.mock ? 'HCP_MOCK' : config.hcp.mockWrites ? 'HCP_MOCK_WRITES' : null;
    const simulated = mode ? `\n_Simulated (${mode}): nothing was written to Housecall Pro._` : '';
    if (row.slack_ts) {
      await updateApprovalMessage(row.slack_ts, msg, `:white_check_mark: *Approved* by ${decidedBy} and executed.${simulated}\n\`\`\`${summarize(result)}\`\`\``, originalBlocks)
        .catch((e) => console.error(`Slack update failed for ${id}: ${(e as Error).message}`));
    }
  } catch (err) {
    const reason = (err as Error).message;
    await db.from('approval_requests').update({ status: 'failed', result: { error: reason } }).eq('id', id);
    await logToolCall({ agent: row.agent, tool: row.tool, inputs: row.inputs, result: { error: reason, decided_by: decidedBy }, status: 'error', latency_ms: Date.now() - start });
    if (row.slack_ts) {
      await updateApprovalMessage(row.slack_ts, msg, `:warning: *Approved* by ${decidedBy} but *failed*: ${reason}`, originalBlocks)
        .catch((e) => console.error(`Slack update failed for ${id}: ${(e as Error).message}`));
    }
    await postAlert(`Approved action *${row.tool}* (request \`${id}\`, agent ${row.agent}) failed: ${reason}`);
  }
  return { outcome: 'done' };
}

/** Handles a verified Slack Approve/Reject click: approver check, decision, and private replies to the clicker. */
export async function handleSlackInteraction(payload: Record<string, any>): Promise<void> {
  const action = payload.type === 'block_actions' ? payload.actions?.[0] : undefined;
  if (!action || !['approve', 'reject'].includes(action.action_id)) return;

  const user = payload.user ?? {};
  const decidedBy = `${user.username ?? user.name ?? 'unknown'} (${user.id})`;
  const responseUrl: string = payload.response_url;

  if (config.slack.approverIds.length && !config.slack.approverIds.includes(user.id)) {
    await replyEphemeral(responseUrl, ':no_entry: You are not on the approver list for Housecall Pro actions.');
    return;
  }
  const { outcome, status } = await decide(action.value, action.action_id === 'approve', decidedBy, payload.message?.blocks);
  if (outcome === 'already_decided') await replyEphemeral(responseUrl, `This request was already handled (status: ${status}). No action taken.`);
  if (outcome === 'not_found') await replyEphemeral(responseUrl, 'Approval request not found.');
}
