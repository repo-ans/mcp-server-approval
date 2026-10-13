// Job request workflow: email text or PDF -> Claude extracts customer + job -> one Slack approval
// -> on Approve: create_customer (unless the customer already exists), then create_job for that customer.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from '../config.js';
import { registerAction, submitForApproval } from '../core/approval.js';
import { logToolCall } from '../core/logger.js';
import type { AnyTool } from '../core/types.js';
import * as hcp from '../connectors/housecallpro/client.js';
import { tools } from '../connectors/housecallpro/tools.js';

export const WORKFLOW_NAME = 'job_request';

// ---------- Extraction schema (what Claude must return) ----------
// Unknown values are null rather than omitted, so the shape is always complete.

const ExtractionSchema = z.object({
  customer: z.object({
    first_name: z.string(),
    last_name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable().describe('Digits only, e.g. "5125550111"'),
    address: z
      .object({ street: z.string(), city: z.string(), state: z.string(), zip: z.string() })
      .nullable()
      .describe('Service address where the work happens'),
  }),
  job: z.object({
    description: z.string().describe('Short work order title, e.g. "AC not cooling - diagnose and repair"'),
    scheduled_start: z.string().nullable().describe('ISO 8601 with timezone offset, only if a specific date/time was requested'),
    notes: z.string().nullable().describe('Access instructions, preferences and other details for the technician'),
  }),
});
export type JobRequest = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You read incoming service requests (emails, web forms, PDF work orders) for a home-services company
and extract the customer and the requested job for entry into Housecall Pro.

- Use only information present in the document. Use null for anything not stated; never invent emails, phones or addresses.
- The customer is the person or company requesting service at the service address (for a property manager, use the
  contact person's name and put the tenant/property details in notes).
- phone: digits only, no country code for US numbers.
- job.description: a short work-order title (under 80 characters).
- job.scheduled_start: only when a specific date and time are requested; resolve relative dates ("next Tuesday at 9am")
  against the date the request was sent, in the customer's local time with offset. A vague window ("sometime next week")
  is not a start time: put it in notes instead.
- job.notes: everything a technician needs: symptoms, equipment, access codes, pets, availability windows, budget.`;

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

let anthropic: Anthropic | undefined;

export type JobRequestInput = { text: string } | { pdfBase64: string };

/** Sends the email text or PDF to Claude and returns the validated extraction. */
export async function extractJobRequest(input: JobRequestInput): Promise<JobRequest> {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set; the job request workflow needs it.');
  anthropic ??= new Anthropic({ apiKey: config.anthropic.apiKey });

  const today = `Today is ${new Date().toISOString().slice(0, 10)}.`;
  const content: Anthropic.Beta.BetaContentBlockParam[] =
    'pdfBase64' in input
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdfBase64 } },
          { type: 'text', text: `${today} Extract the customer and job from this service request PDF.` },
        ]
      : [{ type: 'text', text: `${today} Extract the customer and job from this service request:\n\n<request>\n${input.text}\n</request>` }];

  const useFallback = FALLBACK_MODELS.has(config.anthropic.model);
  const response = await anthropic.beta.messages.parse({
    model: config.anthropic.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'low', format: betaZodOutputFormat(ExtractionSchema) },
    ...(useFallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to process this document.');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens while extracting; the document may be too long.');
  if (!response.parsed_output) throw new Error('Claude did not return valid JSON for the job request.');
  return ExtractionSchema.parse(response.parsed_output);
}

// ---------- Approval: one request covering both steps ----------

interface Plan {
  source: 'text' | 'pdf';
  existing_customer: { id: string; name: string } | null;
  request: JobRequest;
}

const toolByName = (name: string): AnyTool => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

/** Looks for an existing customer with the same email or phone, so approval doesn't create a duplicate. */
async function findExistingCustomer(c: JobRequest['customer']): Promise<Plan['existing_customer']> {
  for (const q of [c.email, c.phone]) {
    if (!q) continue;
    const { customers } = await hcp.searchCustomers(q, 1);
    const match = customers[0];
    if (match) return { id: match.id, name: [match.first_name, match.last_name].filter(Boolean).join(' ') };
  }
  return null;
}

function describePlan(inputs: Record<string, unknown>): string {
  const { source, existing_customer, request } = inputs as unknown as Plan;
  const c = request.customer;
  const j = request.job;
  const addr = c.address ? `${c.address.street}, ${c.address.city}, ${c.address.state} ${c.address.zip}` : '_none given_';
  const step1 = existing_customer
    ? `*1. Customer:* use existing *${existing_customer.name}* (\`${existing_customer.id}\`), matched by email/phone`
    : `*1. Create customer:* ${c.first_name} ${c.last_name}\n      email: ${c.email ?? '_none_'} · phone: ${c.phone ?? '_none_'}\n      address: ${addr}`;
  const step2 = `*2. Create job:* ${j.description}\n      scheduled: ${j.scheduled_start ?? '_unscheduled_'}${j.notes ? `\n      notes: ${j.notes}` : ''}`;
  return `_Extracted by Claude from ${source === 'pdf' ? 'a PDF' : 'an email'}:_\n${step1}\n${step2}`;
}

async function runPlan(inputs: Record<string, unknown>): Promise<unknown> {
  const { existing_customer, request } = inputs as unknown as Plan;
  const c = request.customer;

  let customerId = existing_customer?.id;
  let addressId: string | undefined;
  let customerResult: unknown = existing_customer ? { existing: true, ...existing_customer } : undefined;

  if (!customerId) {
    const created = (await toolByName('create_customer').handler({
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email ?? undefined,
      mobile_number: c.phone ?? undefined,
      address: c.address ? { ...c.address, country: 'US' } : undefined,
    })) as { customer_id: string; address_id: string | null };
    customerId = created.customer_id;
    addressId = created.address_id ?? undefined;
    customerResult = created;
  }

  // Step 2 uses the new customer's id (and address id) from step 1.
  try {
    const job = await toolByName('create_job').handler({
      customer_id: customerId,
      address_id: addressId,
      description: request.job.description,
      scheduled_start: request.job.scheduled_start ?? undefined,
      notes: request.job.notes ?? undefined,
    });
    return { customer: customerResult, job };
  } catch (err) {
    // Make a partial result explicit so nobody re-approves and creates a duplicate customer.
    const created = existing_customer ? '' : `Customer ${c.first_name} ${c.last_name} WAS created (${customerId}), but `;
    throw new Error(`${created}creating the job failed: ${(err as Error).message}`);
  }
}

registerAction(WORKFLOW_NAME, { run: runPlan, describe: describePlan });

/** Full workflow up to the approval gate. Nothing is written to Housecall Pro until someone approves in Slack. */
export async function submitJobRequest(agent: string, input: JobRequestInput) {
  const start = Date.now();
  const source: Plan['source'] = 'pdfBase64' in input ? 'pdf' : 'text';
  // Never log the document itself (PDF base64 / full email), only its size.
  const logInputs = { source, bytes: 'pdfBase64' in input ? Math.round((input.pdfBase64.length * 3) / 4) : input.text.length };
  try {
    const request = await extractJobRequest(input);
    const existing_customer = await findExistingCustomer(request.customer);
    const plan: Plan = { source, existing_customer, request };
    const approvalRequestId = await submitForApproval(agent, WORKFLOW_NAME, plan as unknown as Record<string, unknown>);
    await logToolCall({ agent, tool: WORKFLOW_NAME, inputs: logInputs, result: { approval_request_id: approvalRequestId, extracted: request }, status: 'pending_approval', latency_ms: Date.now() - start });
    return { status: 'pending_approval' as const, approval_request_id: approvalRequestId, existing_customer, extracted: request };
  } catch (err) {
    await logToolCall({ agent, tool: WORKFLOW_NAME, inputs: logInputs, result: { error: (err as Error).message }, status: 'error', latency_ms: Date.now() - start });
    throw err;
  }
}
