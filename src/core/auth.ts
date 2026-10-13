import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { db } from './db.js';
import type { Agent } from './types.js';

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');
export const generateApiKey = () => `hcp_${randomBytes(24).toString('base64url')}`;

// Small in-memory cache so every MCP request doesn't hit Supabase. Revoked keys stop working within 60s.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { agent: Agent | null; expires: number }>();
export const clearAuthCache = () => cache.clear();

async function lookupAgent(apiKey: string): Promise<Agent | null> {
  const hash = hashApiKey(apiKey);
  const hit = cache.get(hash);
  if (hit && hit.expires > Date.now()) return hit.agent;

  const { data, error } = await db.from('agents').select('name, role').eq('api_key_hash', hash).maybeSingle();
  if (error) throw new Error(`Agent lookup failed: ${error.message}`);
  const agent = data ? { name: data.name as string, role: data.role as Agent['role'] } : null;
  cache.set(hash, { agent, expires: Date.now() + CACHE_TTL_MS });
  return agent;
}

function extractKey(authHeader: string | undefined, xApiKey: string | string[] | undefined): string | null {
  if (authHeader?.toLowerCase().startsWith('bearer ')) return authHeader.slice(7).trim() || null;
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
  return null;
}

const unauthorized = (message: string) => ({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

/** Express middleware: resolves the API key to an agent and stores it in res.locals.agent. */
export const requireAgent: RequestHandler = async (req, res, next) => {
  const key = extractKey(req.headers.authorization, req.headers['x-api-key']);
  if (!key) {
    res.status(401).json(unauthorized('Missing API key. Send "Authorization: Bearer <key>" or "x-api-key: <key>".'));
    return;
  }
  try {
    const agent = await lookupAgent(key);
    if (!agent) {
      res.status(401).json(unauthorized('Invalid API key.'));
      return;
    }
    res.locals.agent = agent;
    next();
  } catch (err) {
    console.error((err as Error).message);
    res.status(503).json(unauthorized('Auth backend unavailable, try again shortly.'));
  }
};
