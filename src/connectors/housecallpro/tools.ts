import { z } from 'zod';
import { defineTool, type AnyTool } from '../../core/types.js';
import * as hcp from './client.js';
import type { Json } from './client.js';

// ---------- Formatting helpers (keep responses small and readable for the model) ----------

const dollars = (cents: unknown) => (typeof cents === 'number' ? Math.round(cents) / 100 : null);
const fullName = (p: Json | null | undefined) => (p ? [p.first_name, p.last_name].filter(Boolean).join(' ') || null : null);
const fullAddress = (a: Json | null | undefined) =>
  a ? [a.street, a.street_line_2, a.city, a.state, a.zip].filter(Boolean).join(', ') || null : null;
const noteText = (notes: unknown) =>
  Array.isArray(notes) ? notes.map((n: Json) => n.content).filter(Boolean).join('\n') || null : (notes as string) || null;

const jobSummary = (j: Json) => ({
  id: j.id,
  invoice_number: j.invoice_number ?? null,
  description: j.description ?? null,
  work_status: j.work_status ?? null,
  customer: fullName(j.customer),
  customer_id: j.customer?.id ?? null,
  address: fullAddress(j.address),
  scheduled_start: j.schedule?.scheduled_start ?? null,
  scheduled_end: j.schedule?.scheduled_end ?? null,
  assigned_to: (j.assigned_employees ?? []).map(fullName),
  total_amount_usd: dollars(j.total_amount),
  outstanding_balance_usd: dollars(j.outstanding_balance),
});

const workStatus = z
  .array(z.enum(['unscheduled', 'scheduled', 'in_progress', 'completed', 'canceled']))
  .optional()
  .describe('Filter by one or more statuses. Omit for all.');
const limit = z.number().int().min(1).max(100).default(10).describe('Max results (default 10)');

const address = z.object({
  street: z.string().min(1),
  street_line_2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(2),
  zip: z.string().min(3),
  country: z.string().default('US'),
});

const lineItem = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  unit_price_usd: z.number().min(0).describe('Price per unit in dollars'),
  quantity: z.number().positive().default(1),
  kind: z.enum(['labor', 'materials']).default('labor'),
});

const toCents = (usd: number) => Math.round(usd * 100);
const toLineItem = ({ unit_price_usd, ...li }: z.infer<typeof lineItem>) => ({ ...li, unit_price: toCents(unit_price_usd) });
const plusHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3_600_000).toISOString();

// ---------- Tools ----------

export const tools: AnyTool[] = [
  defineTool({
    name: 'find_customer',
    type: 'read',
    description: [
      'Search Housecall Pro customers by name, email, phone number, company or street address.',
      'Use this before creating a customer (to avoid duplicates) or to get a customer_id needed by other tools.',
      'Returns up to `limit` matches with id, name, contact details and addresses.',
      'Examples: {"query": "Sarah Mitchell"}, {"query": "512-555-0142"}, {"query": "Barton Hills"}',
    ].join('\n'),
    inputSchema: {
      query: z.string().min(2).describe('Free-text search: name, email, phone, company or address'),
      limit,
    },
    handler: async ({ query, limit }) => {
      const res = await hcp.searchCustomers(query, limit);
      return {
        total_matches: res.total_items,
        customers: res.customers.map((c) => ({
          id: c.id,
          name: fullName(c),
          company: c.company ?? null,
          email: c.email ?? null,
          mobile_number: c.mobile_number ?? null,
          addresses: (c.addresses ?? []).map((a: Json) => ({ id: a.id, type: a.type, full: fullAddress(a) })),
          tags: c.tags ?? [],
        })),
      };
    },
  }),

  defineTool({
    name: 'find_job',
    type: 'read',
    description: [
      'List Housecall Pro jobs, newest first, filtered by customer, work status and/or scheduled date range.',
      'Use this to find a job_id when you know the customer, or to answer "what is scheduled this week?".',
      'Housecall Pro cannot search jobs by name: call find_customer first to get a customer_id.',
      'Dates are ISO 8601 (e.g. "2026-10-13" or "2026-10-13T00:00:00Z").',
      'Examples: {"customer_id": "cus_4f8a2c1e9b7d4a63"}, {"work_status": ["scheduled"], "scheduled_from": "2026-10-13", "scheduled_to": "2026-10-20"}',
    ].join('\n'),
    inputSchema: {
      customer_id: z.string().optional().describe('Only jobs for this customer (from find_customer)'),
      work_status: workStatus,
      scheduled_from: z.string().optional().describe('Scheduled start on/after this date (ISO 8601)'),
      scheduled_to: z.string().optional().describe('Scheduled start on/before this date (ISO 8601)'),
      limit,
    },
    handler: async ({ customer_id, work_status, scheduled_from, scheduled_to, limit }) => {
      const res = await hcp.listJobs({
        customer_id,
        work_status,
        scheduled_start_min: scheduled_from,
        scheduled_start_max: scheduled_to,
        page_size: limit,
      });
      return { total_matches: res.total_items, jobs: res.jobs.map(jobSummary) };
    },
  }),

  defineTool({
    name: 'get_job_status',
    type: 'read',
    description: [
      'Get the current status of one Housecall Pro job: work status (needs scheduling, scheduled, in progress, complete, canceled),',
      'schedule, on-my-way/started/completed timestamps, assigned technicians, total and outstanding balance (in dollars) and notes.',
      'Use this when someone asks "where is the tech?", "is job X done?" or "what is the balance on job X?".',
      'Needs a job id (e.g. "job_3e7f1a9c5b2d4f60"); use find_job first if you only have a customer.',
      'Example: {"job_id": "job_3e7f1a9c5b2d4f60"}',
    ].join('\n'),
    inputSchema: {
      job_id: z.string().min(1).describe('Housecall Pro job id, e.g. "job_3e7f1a9c5b2d4f60"'),
    },
    handler: async ({ job_id }) => {
      const j = await hcp.getJob(job_id);
      return {
        ...jobSummary(j),
        on_my_way_at: j.work_timestamps?.on_my_way_at ?? null,
        started_at: j.work_timestamps?.started_at ?? null,
        completed_at: j.work_timestamps?.completed_at ?? null,
        tags: j.tags ?? [],
        notes: noteText(j.notes),
      };
    },
  }),

  defineTool({
    name: 'list_estimates',
    type: 'read',
    description: [
      'List Housecall Pro estimates, newest first, optionally for one customer and/or by work status.',
      'Each estimate shows its options (e.g. good/better/best) with price in dollars and approval status.',
      'Use this for "what did we quote customer X?" or "which estimates are still open?".',
      'Examples: {"customer_id": "cus_a19c6f3b8e2d4b17"}, {"work_status": ["scheduled", "unscheduled"]}',
    ].join('\n'),
    inputSchema: {
      customer_id: z.string().optional().describe('Only estimates for this customer (from find_customer)'),
      work_status: workStatus,
      limit,
    },
    handler: async ({ customer_id, work_status, limit }) => {
      const res = await hcp.listEstimates({ customer_id, work_status, page_size: limit });
      return {
        total_matches: res.total_items,
        estimates: res.estimates.map((e) => ({
          id: e.id,
          estimate_number: e.estimate_number ?? null,
          work_status: e.work_status ?? null,
          customer: fullName(e.customer),
          customer_id: e.customer?.id ?? null,
          address: fullAddress(e.address),
          scheduled_start: e.schedule?.scheduled_start ?? null,
          assigned_to: (e.assigned_employees ?? []).map(fullName),
          options: (e.options ?? []).map((o: Json) => ({
            id: o.id,
            name: o.name,
            option_number: o.option_number,
            total_amount_usd: dollars(o.total_amount),
            approval_status: o.approval_status ?? null,
            status: o.status ?? null,
          })),
          created_at: e.created_at ?? null,
        })),
      };
    },
  }),

  defineTool({
    name: 'list_unpaid_invoices',
    type: 'read',
    description: [
      'List Housecall Pro invoices that are not fully paid (status "open" or "pending_payment"), oldest due date first,',
      'with amount due in dollars and the total outstanding across the results.',
      'Use this for "who owes us money?", "what is overdue?" or "does customer X have an open balance?".',
      'Set due_before to today\'s date to get only overdue invoices. Each invoice has a job_id you can pass to get_job_status for customer details.',
      'Examples: {}, {"customer_id": "cus_7b3e0d5a2f1c4e88"}, {"due_before": "2026-10-13"}',
    ].join('\n'),
    inputSchema: {
      customer_id: z.string().optional().describe('Only invoices for this customer (from find_customer)'),
      due_before: z.string().optional().describe('Only invoices due on/before this date (ISO 8601). Use today for overdue.'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max results (default 25)'),
    },
    handler: async ({ customer_id, due_before, limit }) => {
      const res = await hcp.listInvoices({ status: ['open', 'pending_payment'], customer_id, due_at_max: due_before, page_size: limit });
      const invoices = res.invoices.map((i) => ({
        id: i.id,
        invoice_number: i.invoice_number ?? null,
        job_id: i.job_id ?? null,
        status: i.status,
        amount_usd: dollars(i.amount),
        due_amount_usd: dollars(i.due_amount),
        due_at: i.due_at ?? null,
        sent_at: i.sent_at ?? null,
        service_date: i.service_date ?? null,
      }));
      const totalDue = invoices.reduce((sum, i) => sum + (i.due_amount_usd ?? 0), 0);
      return { total_matches: res.total_items, total_due_usd: Math.round(totalDue * 100) / 100, invoices };
    },
  }),

  // ---------- Write tools: never executed directly. The core queues them for human approval in Slack;
  // the handler only runs after someone clicks Approve. ----------

  defineTool({
    name: 'create_customer',
    type: 'write',
    description: [
      'Create a new customer in Housecall Pro. REQUIRES HUMAN APPROVAL: the request is posted to Slack and only',
      'executed after a person clicks Approve. You get back a pending approval request id, not the customer.',
      'Always call find_customer first to avoid duplicates. Provide a name plus email or mobile number, and the',
      'service address if known (a job needs one). Customer notifications are created disabled.',
      'Example: {"first_name": "Jordan", "last_name": "Blake", "email": "jordan@example.com", "mobile_number": "5125550111",',
      ' "address": {"street": "742 Oak Ridge Dr", "city": "Austin", "state": "TX", "zip": "78745"}}',
    ].join('\n'),
    inputSchema: {
      first_name: z.string().min(1),
      last_name: z.string().min(1),
      email: z.string().email().optional(),
      mobile_number: z.string().optional().describe('Digits only is fine, e.g. "5125550111"'),
      company: z.string().optional(),
      address: address.optional().describe('Service address'),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      lead_source: z.string().optional().describe('Must exactly match a lead source already set up in Housecall Pro (otherwise the create fails). Omit unless the user names one.'),
    },
    handler: async ({ address, ...rest }) => {
      const c = await hcp.createCustomer({ ...rest, addresses: address ? [address] : undefined });
      return {
        simulated: c.simulated ?? false,
        customer_id: c.id,
        name: fullName(c),
        address_id: c.addresses?.[0]?.id ?? null,
        address: fullAddress(c.addresses?.[0]),
      };
    },
  }),

  defineTool({
    name: 'create_job',
    type: 'write',
    description: [
      'Create a new job (work order) for an existing Housecall Pro customer. REQUIRES HUMAN APPROVAL in Slack;',
      'you get back a pending approval request id. Needs a customer_id from find_customer.',
      "The description becomes the job's first line item; price_usd is optional (0 if unknown).",
      "If address_id is omitted the customer's first address is used. Times are ISO 8601 with timezone offset.",
      'Example: {"customer_id": "cus_4f8a2c1e9b7d4a63", "description": "Replace kitchen faucet", "price_usd": 250,',
      ' "scheduled_start": "2026-10-20T09:00:00-05:00", "scheduled_end": "2026-10-20T11:00:00-05:00", "notes": "Side gate code 1234"}',
    ].join('\n'),
    inputSchema: {
      customer_id: z.string().min(1),
      address_id: z.string().optional().describe('Customer address id; defaults to the first address on file'),
      description: z.string().min(3).describe('What work is to be done'),
      price_usd: z.number().min(0).optional().describe('Price of the work in dollars'),
      scheduled_start: z.string().optional().describe('ISO 8601; omit to leave the job unscheduled'),
      scheduled_end: z.string().optional().describe('ISO 8601; defaults to 2 hours after start'),
      arrival_window_minutes: z.number().int().min(0).optional(),
      notes: z.string().optional().describe('Internal notes for the technician'),
      tags: z.array(z.string()).optional(),
    },
    handler: async (i) => {
      const job = await hcp.createJob({
        customer_id: i.customer_id,
        address_id: i.address_id,
        line_items: [{ name: i.description, unit_price: toCents(i.price_usd ?? 0), quantity: 1, kind: 'labor' }],
        schedule: i.scheduled_start
          ? { scheduled_start: i.scheduled_start, scheduled_end: i.scheduled_end ?? plusHours(i.scheduled_start, 2), arrival_window: i.arrival_window_minutes }
          : undefined,
        notes: i.notes,
        tags: i.tags,
      });
      return { simulated: job.simulated ?? false, job_id: job.id, invoice_number: job.invoice_number ?? null, work_status: job.work_status ?? null };
    },
  }),

  defineTool({
    name: 'update_job',
    type: 'write',
    description: [
      'Update an existing Housecall Pro job: reschedule it and/or add an internal note. REQUIRES HUMAN APPROVAL in Slack;',
      'you get back a pending approval request id. (The Housecall Pro API only allows changing the schedule and adding notes.)',
      'Provide scheduled_start (+ optional scheduled_end) and/or note. The customer is NOT notified unless notify_customer is true.',
      'Examples: {"job_id": "job_8c2b6e4d1a9f4c35", "scheduled_start": "2026-10-17T13:00:00-05:00"},',
      ' {"job_id": "job_3e7f1a9c5b2d4f60", "note": "Customer asked for a call 30 min before arrival"}',
    ].join('\n'),
    inputSchema: {
      job_id: z.string().min(1),
      scheduled_start: z.string().optional().describe('New start time, ISO 8601'),
      scheduled_end: z.string().optional().describe('New end time, ISO 8601; defaults to 2 hours after start'),
      arrival_window_minutes: z.number().int().min(0).optional(),
      notify_customer: z.boolean().default(false),
      note: z.string().optional().describe('Internal note to add to the job'),
    },
    validate: (i) => {
      if (!i.scheduled_start && !i.note) throw new Error('Nothing to update: provide scheduled_start and/or note.');
    },
    handler: async (i) => {
      const result: Record<string, unknown> = { job_id: i.job_id, simulated: false };
      if (i.scheduled_start) {
        const s = await hcp.updateJobSchedule(i.job_id, {
          start_time: i.scheduled_start,
          end_time: i.scheduled_end ?? plusHours(i.scheduled_start, 2),
          arrival_window_in_minutes: i.arrival_window_minutes,
          notify: i.notify_customer,
          notify_pro: true,
        });
        result.rescheduled_to = i.scheduled_start;
        result.simulated = s.simulated ?? false;
      }
      if (i.note) {
        const n = await hcp.addJobNote(i.job_id, i.note);
        result.note_added = true;
        result.simulated = n.simulated ?? false;
      }
      return result;
    },
  }),

  defineTool({
    name: 'create_estimate',
    type: 'write',
    description: [
      'Create an estimate (quote) for an existing Housecall Pro customer with one or more options (e.g. Good / Better / Best),',
      'each with line items priced in dollars. REQUIRES HUMAN APPROVAL in Slack; you get back a pending approval request id.',
      "Needs a customer_id from find_customer; the address defaults to the customer's first address.",
      'Example: {"customer_id": "cus_a19c6f3b8e2d4b17", "options": [',
      ' {"name": "Repair", "line_items": [{"name": "Capacitor replacement", "unit_price_usd": 285}]},',
      ' {"name": "Replace", "line_items": [{"name": "New 3-ton condenser", "unit_price_usd": 6200, "kind": "materials"}, {"name": "Install labor", "unit_price_usd": 1400}]}]}',
    ].join('\n'),
    inputSchema: {
      customer_id: z.string().min(1),
      address_id: z.string().optional(),
      options: z.array(z.object({ name: z.string().min(1), line_items: z.array(lineItem).min(1) })).min(1).max(5),
      message: z.string().optional().describe('Message to the customer shown on the estimate'),
      note: z.string().optional().describe('Internal note'),
    },
    handler: async (i) => {
      const est = await hcp.createEstimate({
        customer_id: i.customer_id,
        address_id: i.address_id,
        message: i.message,
        note: i.note,
        options: i.options.map((o) => ({ name: o.name, line_items: o.line_items.map(toLineItem) })),
      });
      return {
        simulated: est.simulated ?? false,
        estimate_id: est.id,
        estimate_number: est.estimate_number ?? null,
        options: i.options.map((o) => ({ name: o.name, total_usd: o.line_items.reduce((s, li) => s + li.unit_price_usd * li.quantity, 0) })),
      };
    },
  }),

  defineTool({
    name: 'create_invoice',
    type: 'write',
    description: [
      'Bill work on a Housecall Pro job by adding line items to its invoice. In Housecall Pro every job has one invoice',
      '(same number as the job) built from its line items; the public API has no separate "create invoice" call.',
      'REQUIRES HUMAN APPROVAL in Slack; you get back a pending approval request id. Prices are in dollars.',
      'Use get_job_status first to confirm the job. Example: {"job_id": "job_3e7f1a9c5b2d4f60", "line_items": [',
      ' {"name": "Dual run capacitor 45/5 MFD", "unit_price_usd": 185, "kind": "materials"}, {"name": "Diagnostic + repair labor", "unit_price_usd": 300}]}',
    ].join('\n'),
    inputSchema: {
      job_id: z.string().min(1),
      line_items: z.array(lineItem).min(1).max(20),
    },
    handler: async ({ job_id, line_items }) => {
      const added: Json[] = [];
      for (const li of line_items) added.push(await hcp.addJobLineItem(job_id, toLineItem(li)));
      return {
        simulated: added.some((a) => a.simulated),
        job_id,
        line_items_added: added.length,
        amount_added_usd: line_items.reduce((s, li) => s + li.unit_price_usd * li.quantity, 0),
      };
    },
  }),
];
