// Slack slash command for admins to manage API keys without the code:  /hcp-agent create|list|role|revoke|help
// Replies are ephemeral (only the admin who typed the command sees them; Slack doesn't keep them in history).
import { config } from '../config.js';
import { checkName, checkRole, createAgent, listAgents, revokeAgent, setAgentRole } from './agents.js';
import { logToolCall } from './logger.js';

const HELP = [
  '*Housecall Pro MCP: API key admin*',
  '`/hcp-agent create <name> <read_only|writer>`: create a key for a person or integration',
  '`/hcp-agent list`: show all agents and their roles',
  '`/hcp-agent role <name> <read_only|writer>`: change a role',
  '`/hcp-agent revoke <name>`: delete an agent; its key stops working',
  '_read_only_ = can look things up. _writer_ = can also request changes (each change still needs Approve here in Slack).',
].join('\n');

export interface SlashReply {
  response_type: 'ephemeral';
  text: string;
}

const reply = (text: string): SlashReply => ({ response_type: 'ephemeral', text });

/** Handles a verified /hcp-agent command. `host` is the public hostname, used to show the connection URL. */
export async function handleAgentCommand(form: URLSearchParams, host: string): Promise<SlashReply> {
  const userId = form.get('user_id') ?? '';
  const admin = `slack:${form.get('user_name') ?? 'unknown'} (${userId})`;

  if (!config.slack.adminIds.length) {
    return reply(':no_entry: Key management is turned off. Set SLACK_ADMIN_IDS (comma-separated Slack user ids) on the server.');
  }
  if (!config.slack.adminIds.includes(userId)) {
    return reply(':no_entry: Only Housecall Pro MCP admins can manage API keys.');
  }

  const [action = 'help', name, role] = (form.get('text') ?? '').trim().split(/\s+/).filter(Boolean);
  const audit = (tool: string, inputs: unknown) =>
    logToolCall({ agent: admin, tool, inputs, result: null, status: 'success', latency_ms: 0 });

  try {
    switch (action.toLowerCase()) {
      case 'create': {
        const n = checkName(name);
        const r = checkRole(role);
        const key = await createAgent(n, r);
        await audit('admin_create_agent', { name: n, role: r });
        const mcpUrl = `https://${host}/mcp`;
        return reply(
          [
            `:white_check_mark: Created *${n}* with role *${r}*. Copy the key now: it is shown only once and can't be recovered.`,
            '```' + key + '```',
            `*How ${n} connects* (send this privately, e.g. a one-time link from onetimesecret.com or Bitwarden Send):`,
            `• *claude.ai:* Customize → Connectors → Add custom connector → URL \`${mcpUrl}\` → Authentication: No sign-in → Request headers: \`authorization\` = \`Bearer <the key above>\``,
            `• *Claude Code:* \`claude mcp add --transport http housecallpro ${mcpUrl} --header "Authorization: Bearer <key>"\``,
          ].join('\n'),
        );
      }
      case 'list': {
        const agents = await listAgents();
        if (!agents.length) return reply('No agents yet. Create one with `/hcp-agent create <name> <role>`.');
        return reply(['*Agents*', ...agents.map((a) => `• *${a.name}*: ${a.role} (since ${a.created_at.slice(0, 10)})`)].join('\n'));
      }
      case 'role': {
        const n = checkName(name);
        const r = checkRole(role);
        await setAgentRole(n, r);
        await audit('admin_set_role', { name: n, role: r });
        return reply(`:white_check_mark: *${n}* is now *${r}*.`);
      }
      case 'revoke': {
        const n = checkName(name);
        await revokeAgent(n);
        await audit('admin_revoke_agent', { name: n });
        return reply(`:white_check_mark: Revoked *${n}*. Their key no longer works (within a minute at most).`);
      }
      default:
        return reply(HELP);
    }
  } catch (err) {
    return reply(`:warning: ${(err as Error).message}`);
  }
}
