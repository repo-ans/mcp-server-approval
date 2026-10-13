// Usage: npm run create-agent -- <name> <read_only|writer>
// Prints the new API key ONCE. Only its sha256 hash is stored in Supabase.
import { db } from '../core/db.js';
import { generateApiKey, hashApiKey } from '../core/auth.js';

const [name, role] = process.argv.slice(2);
const roles = ['read_only', 'writer'];

if (!name || !role || !roles.includes(role)) {
  console.error('Usage: npm run create-agent -- <name> <read_only|writer>');
  console.error('Example: npm run create-agent -- claude-dispatcher writer');
  process.exit(1);
}

const apiKey = generateApiKey();
const { error } = await db.from('agents').insert({ name, role, api_key_hash: hashApiKey(apiKey) });

if (error) {
  console.error(error.code === '23505' ? `An agent named "${name}" already exists.` : `Failed to create agent: ${error.message}`);
  process.exit(1);
}

console.log(`\nAgent "${name}" created with role "${role}".`);
console.log('\nAPI key (shown once, store it somewhere safe):\n');
console.log(`  ${apiKey}\n`);
