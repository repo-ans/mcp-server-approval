// Usage: npm run create-agent -- <name> <read_only|writer>
// Developer alternative to the Slack admin command (/hcp-agent create <name> <role>).
// Prints the new API key ONCE. Only its sha256 hash is stored in Supabase.
import { checkName, checkRole, createAgent } from '../core/agents.js';

const [name, role] = process.argv.slice(2);

try {
  const n = checkName(name);
  const r = checkRole(role);
  const apiKey = await createAgent(n, r);
  console.log(`\nAgent "${n}" created with role "${r}".`);
  console.log('\nAPI key (shown once, store it somewhere safe):\n');
  console.log(`  ${apiKey}\n`);
} catch (err) {
  console.error((err as Error).message);
  console.error('Usage: npm run create-agent -- <name> <read_only|writer>   e.g. npm run create-agent -- claude-dispatcher writer');
  process.exit(1);
}
