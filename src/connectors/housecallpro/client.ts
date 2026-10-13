// ALL Housecall Pro HTTP calls live in this file.
// Reference: Housecall v1 public API (OpenAPI spec published at https://docs.housecallpro.com)
//   Base URL: https://api.housecallpro.com    Auth header: "Authorization: Token <API_KEY>"
//   Array query params use Rails style: status[]=open&status[]=pending_payment
//   Money fields are integers in cents.
import { config } from '../../config.js';
import { mockCustomers, mockEstimates, mockInvoices, mockJobs } from './mock.js';

export class HcpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'HcpError';
  }
}

// Housecall Pro objects are large and loosely typed; tools pick out the fields they need.
export type Json = Record<string, any>;
type Query = Record<string, string | number | string[] | undefined>;

async function hcpRequest<T = Json>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  const url = new URL(config.hcp.baseUrl + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(`${k}[]`, item));
    else if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Token ${config.hcp.apiKey}`,
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HcpError(`Could not reach Housecall Pro (${(err as Error).message}). Try again shortly.`);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 300);
    switch (res.status) {
      case 401:
      case 403:
        throw new HcpError('Housecall Pro rejected the API key (check HCP_API_KEY and that the account is on a plan with API access).', res.status);
      case 404:
        throw new HcpError(`Not found in Housecall Pro (${method} ${path}).`, 404);
      case 400:
      case 422:
        throw new HcpError(`Housecall Pro rejected the request: ${detail}`, res.status);
      case 429:
        throw new HcpError('Housecall Pro rate limit hit. Wait a minute and retry.', 429);
      default:
        throw new HcpError(`Housecall Pro error ${res.status}: ${detail}`, res.status);
    }
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HcpError(`Housecall Pro returned a non-JSON response (${res.status}).`, res.status);
  }
}

// Job/estimate list filters use underscores; returned work_status values use spaces.
const statusMatches: Record<string, string[]> = {
  unscheduled: ['needs scheduling', 'unscheduled'],
  scheduled: ['scheduled'],
  in_progress: ['in progress'],
  completed: ['complete rated', 'complete unrated'],
  canceled: ['user canceled', 'pro canceled'],
};
const matchesStatus = (actual: string, wanted?: string[]) =>
  !wanted?.length || wanted.some((w) => statusMatches[w]?.includes(actual));
const inRange = (iso: string | null | undefined, min?: string, max?: string) =>
  (!min || (!!iso && iso >= min)) && (!max || (!!iso && iso <= max));

// ---------- Customers ----------

export async function searchCustomers(q: string, pageSize = 10): Promise<{ customers: Json[]; total_items: number }> {
  if (config.hcp.mock) {
    const needle = q.toLowerCase().trim();
    const digits = q.replace(/\D/g, '');
    const customers = mockCustomers.filter((c) => {
      const hay = [`${c.first_name} ${c.last_name}`, c.email, c.mobile_number, c.company ?? '',
        ...c.addresses.map((a) => `${a.street} ${a.city} ${a.zip}`)].join(' | ').toLowerCase();
      return hay.includes(needle) || (digits.length >= 7 && c.mobile_number.includes(digits));
    });
    return { customers: customers.slice(0, pageSize), total_items: customers.length };
  }
  return hcpRequest('GET', '/customers', { query: { q, page: 1, page_size: pageSize } });
}

// ---------- Jobs ----------

export interface JobFilters {
  customer_id?: string;
  work_status?: string[];
  scheduled_start_min?: string;
  scheduled_start_max?: string;
  page_size: number;
}

export async function listJobs(f: JobFilters): Promise<{ jobs: Json[]; total_items: number }> {
  if (config.hcp.mock) {
    const jobs = mockJobs.filter((j) =>
      (!f.customer_id || j.customer.id === f.customer_id) &&
      matchesStatus(j.work_status, f.work_status) &&
      inRange(j.schedule.scheduled_start, f.scheduled_start_min, f.scheduled_start_max));
    return { jobs: jobs.slice(0, f.page_size), total_items: jobs.length };
  }
  return hcpRequest('GET', '/jobs', {
    query: { ...f, page: 1, sort_by: 'created_at', sort_direction: 'desc' },
  });
}

export async function getJob(jobId: string): Promise<Json> {
  if (config.hcp.mock) {
    const job = mockJobs.find((j) => j.id === jobId || j.invoice_number === jobId);
    if (!job) throw new HcpError(`Not found in Housecall Pro: no job with id "${jobId}".`, 404);
    return job;
  }
  return hcpRequest('GET', `/jobs/${encodeURIComponent(jobId)}`);
}

// ---------- Estimates ----------

export async function listEstimates(f: { customer_id?: string; work_status?: string[]; page_size: number }): Promise<{ estimates: Json[]; total_items: number }> {
  if (config.hcp.mock) {
    const estimates = mockEstimates.filter((e) =>
      (!f.customer_id || e.customer.id === f.customer_id) && matchesStatus(e.work_status, f.work_status));
    return { estimates: estimates.slice(0, f.page_size), total_items: estimates.length };
  }
  return hcpRequest('GET', '/estimates', {
    query: { ...f, page: 1, sort_by: 'created_at', sort_direction: 'desc' },
  });
}

// ---------- Invoices ----------

export async function listInvoices(f: { status: string[]; customer_id?: string; due_at_max?: string; page_size: number }): Promise<{ invoices: Json[]; total_items: number }> {
  if (config.hcp.mock) {
    const invoices = mockInvoices.filter((i) =>
      f.status.includes(i.status) && (!f.customer_id || i.customer_id === f.customer_id) && inRange(i.due_at, undefined, f.due_at_max));
    return { invoices: invoices.slice(0, f.page_size), total_items: invoices.length };
  }
  return hcpRequest('GET', '/invoices', {
    query: {
      status: f.status,
      customer_uuid: f.customer_id ? [f.customer_id] : undefined,
      due_at_max: f.due_at_max,
      page: 1,
      page_size: f.page_size,
      sort_by: 'due_at',
      sort_direction: 'asc',
    },
  });
}

// ---------- Writes (only ever called after human approval) ----------
// HCP_MOCK or HCP_MOCK_WRITES: return a realistic simulated response instead of writing to Housecall Pro.

const simulateWrites = () => config.hcp.mock || config.hcp.mockWrites;
const simId = (prefix: string) => `${prefix}_sim_${Math.random().toString(16).slice(2, 14)}`;
const now = () => new Date().toISOString();

export interface AddressInput {
  street: string;
  street_line_2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface LineItemInput {
  name: string;
  description?: string;
  unit_price: number; // cents
  quantity: number;
  kind?: 'labor' | 'materials';
  taxable?: boolean;
}

export async function getCustomer(customerId: string): Promise<Json> {
  if (config.hcp.mock) {
    const c = mockCustomers.find((x) => x.id === customerId);
    if (!c) throw new HcpError(`Not found in Housecall Pro: no customer with id "${customerId}".`, 404);
    return c;
  }
  return hcpRequest('GET', `/customers/${encodeURIComponent(customerId)}`);
}

export async function createCustomer(body: {
  first_name?: string;
  last_name?: string;
  email?: string;
  mobile_number?: string;
  company?: string;
  notes?: string;
  tags?: string[];
  lead_source?: string;
  addresses?: AddressInput[];
}): Promise<Json> {
  const payload = { ...body, notifications_enabled: false };
  if (simulateWrites()) {
    return {
      simulated: true,
      id: simId('cus'),
      ...payload,
      addresses: (body.addresses ?? []).map((a) => ({ id: simId('adr'), type: 'service', ...a })),
      created_at: now(),
    };
  }
  return hcpRequest('POST', '/customers', { body: payload });
}

/** Creates a job. If address_id is missing, uses the customer's first address. */
export async function createJob(body: {
  customer_id: string;
  address_id?: string;
  schedule?: { scheduled_start: string; scheduled_end: string; arrival_window?: number };
  line_items: LineItemInput[];
  notes?: string;
  tags?: string[];
  lead_source?: string;
  assigned_employee_ids?: string[];
}): Promise<Json> {
  if (simulateWrites()) {
    return {
      simulated: true,
      id: simId('job'),
      invoice_number: String(10500 + Math.floor(Math.random() * 400)),
      work_status: body.schedule ? 'scheduled' : 'needs scheduling',
      description: body.line_items[0]?.name ?? null,
      ...body,
      address_id: body.address_id ?? '(customer default address)',
      created_at: now(),
    };
  }
  let addressId = body.address_id;
  if (!addressId) {
    const customer = await getCustomer(body.customer_id);
    addressId = customer.addresses?.[0]?.id;
    if (!addressId) throw new HcpError(`Customer ${body.customer_id} has no address on file; add one before creating a job.`, 422);
  }
  return hcpRequest('POST', '/jobs', { body: { ...body, address_id: addressId } });
}

export async function updateJobSchedule(jobId: string, body: {
  start_time: string;
  end_time: string;
  arrival_window_in_minutes?: number;
  notify: boolean;
  notify_pro: boolean;
}): Promise<Json> {
  if (simulateWrites()) return { simulated: true, job_id: jobId, schedule: body, updated_at: now() };
  return hcpRequest('PUT', `/jobs/${encodeURIComponent(jobId)}/schedule`, { body });
}

export async function addJobNote(jobId: string, content: string): Promise<Json> {
  if (simulateWrites()) return { simulated: true, id: simId('nte'), job_id: jobId, content, created_at: now() };
  return hcpRequest('POST', `/jobs/${encodeURIComponent(jobId)}/notes`, { body: { content } });
}

export async function addJobLineItem(jobId: string, item: LineItemInput): Promise<Json> {
  if (simulateWrites()) return { simulated: true, id: simId('li'), job_id: jobId, ...item };
  return hcpRequest('POST', `/jobs/${encodeURIComponent(jobId)}/line_items`, { body: item });
}

export async function createEstimate(body: {
  customer_id: string;
  address_id?: string;
  note?: string;
  message?: string;
  options: Array<{ name: string; line_items: LineItemInput[] }>;
}): Promise<Json> {
  if (simulateWrites()) {
    return {
      simulated: true,
      id: simId('est'),
      estimate_number: String(5100 + Math.floor(Math.random() * 400)),
      ...body,
      options: body.options.map((o) => ({ id: simId('opt'), ...o })),
      created_at: now(),
    };
  }
  const addressId = body.address_id ?? (await getCustomer(body.customer_id)).addresses?.[0]?.id;
  return hcpRequest('POST', '/estimates', { body: { ...body, address_id: addressId } });
}
