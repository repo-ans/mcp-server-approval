import { db } from './db.js';

export type CallStatus = 'success' | 'error' | 'pending_approval' | 'approved' | 'rejected' | 'rejected_permission';

export interface ToolCallLog {
  agent: string;
  tool: string;
  inputs: unknown;
  result: unknown;
  status: CallStatus;
  latency_ms: number;
}

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization/i;

/** Deep-copies a value, replacing anything under a secret-looking key with "[redacted]". */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

/** Inserts one row into tool_calls. Never throws: a logging failure must not break the tool call. */
export async function logToolCall(entry: ToolCallLog): Promise<void> {
  const { error } = await db.from('tool_calls').insert({
    ...entry,
    inputs: redact(entry.inputs),
    result: redact(entry.result ?? null),
  });
  if (error) console.error(`tool_calls insert failed (${entry.tool}): ${error.message}`);
}

/** Runs fn, timing it and logging success or error. Returns fn's result or rethrows its error. */
export async function withLogging<T>(agent: string, tool: string, inputs: unknown, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await logToolCall({ agent, tool, inputs, result, status: 'success', latency_ms: Date.now() - start });
    return result;
  } catch (err) {
    await logToolCall({ agent, tool, inputs, result: { error: (err as Error).message }, status: 'error', latency_ms: Date.now() - start });
    throw err;
  }
}
