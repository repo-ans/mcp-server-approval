// Agent (API key) management, shared by the Slack admin command and the create-agent CLI script.
import { clearAuthCache, generateApiKey, hashApiKey } from './auth.js';
import { db } from './db.js';
import type { Role } from './types.js';

export const ROLES: Role[] = ['read_only', 'writer'];
const NAME = /^[a-z0-9][a-z0-9._-]{1,48}$/;

export function checkName(name: string | undefined): string {
  if (!name || !NAME.test(name)) throw new Error('Name must be 2-49 characters: lowercase letters, digits, ".", "_" or "-" (e.g. "jane-dispatcher").');
  return name;
}

export function checkRole(role: string | undefined): Role {
  if (!role || !ROLES.includes(role as Role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
  return role as Role;
}

/** Creates an agent and returns its API key. The key is returned only here; only its hash is stored. */
export async function createAgent(name: string, role: Role): Promise<string> {
  const apiKey = generateApiKey();
  const { error } = await db.from('agents').insert({ name, role, api_key_hash: hashApiKey(apiKey) });
  if (error) throw new Error(error.code === '23505' ? `An agent named "${name}" already exists.` : error.message);
  return apiKey;
}

export async function listAgents(): Promise<Array<{ name: string; role: Role; created_at: string }>> {
  const { data, error } = await db.from('agents').select('name, role, created_at').order('created_at');
  if (error) throw new Error(error.message);
  return data as Array<{ name: string; role: Role; created_at: string }>;
}

/** Deletes an agent; its key stops working immediately on this server instance, within 60s elsewhere. */
export async function revokeAgent(name: string): Promise<void> {
  const { data, error } = await db.from('agents').delete().eq('name', name).select('name');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`No agent named "${name}".`);
  clearAuthCache();
}

export async function setAgentRole(name: string, role: Role): Promise<void> {
  const { data, error } = await db.from('agents').update({ role }).eq('name', name).select('name');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`No agent named "${name}".`);
  clearAuthCache();
}
