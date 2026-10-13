import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { requireAgent } from './core/auth.js';
import { canCall } from './core/permissions.js';
import { logToolCall, withLogging } from './core/logger.js';
import { submitForApproval } from './core/approval.js';
import { parseSlackInteraction, verifySlackSignature } from './core/slack.js';
import { handleAgentCommand } from './core/slack-commands.js';
import type { Agent, AnyTool } from './core/types.js';
import { tools } from './registry.js';
import { submitJobRequest, WORKFLOW_NAME, type JobRequestInput } from './workflows/job-request.js';

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) });

async function runTool(agent: Agent, tool: AnyTool, input: Record<string, unknown>): Promise<CallToolResult> {
  if (!canCall(agent.role, tool.type)) {
    const message = `Permission denied: agent "${agent.name}" has role "${agent.role}" and cannot call ${tool.type} tool "${tool.name}". Ask an admin for a writer key.`;
    await logToolCall({ agent: agent.name, tool: tool.name, inputs: input, result: { error: message }, status: 'rejected_permission', latency_ms: 0 });
    return text(message, true);
  }
  // Workflow tools prepare and submit their own approval (and log it); nothing is written yet.
  if (tool.submitsOwnApproval) {
    try {
      return text(JSON.stringify(await tool.handler(input, { agent: agent.name }), null, 2));
    } catch (err) {
      return text(`Error in ${tool.name}: ${(err as Error).message}`, true);
    }
  }

  // Write tools never touch Housecall Pro here: they are queued and executed only after Slack approval.
  if (tool.type === 'write') {
    const start = Date.now();
    try {
      tool.validate?.(input);
      const requestId = await submitForApproval(agent.name, tool.name, input);
      await logToolCall({ agent: agent.name, tool: tool.name, inputs: input, result: { approval_request_id: requestId }, status: 'pending_approval', latency_ms: Date.now() - start });
      return text(
        `Pending human approval (request id ${requestId}). The request was posted to Slack; it will be executed in ` +
          `Housecall Pro only after a person clicks Approve. Nothing has been created or changed yet. ` +
          `Tell the user it is awaiting approval; do not retry or resubmit it.`,
      );
    } catch (err) {
      const message = (err as Error).message;
      await logToolCall({ agent: agent.name, tool: tool.name, inputs: input, result: { error: message }, status: 'error', latency_ms: Date.now() - start });
      return text(`Error submitting ${tool.name} for approval: ${message}`, true);
    }
  }

  try {
    const result = await withLogging(agent.name, tool.name, input, () => tool.handler(input, { agent: agent.name }));
    return text(JSON.stringify(result, null, 2));
  } catch (err) {
    return text(`Error in ${tool.name}: ${(err as Error).message}`, true);
  }
}

/** A fresh MCP server per request (stateless Streamable HTTP), bound to the calling agent. */
function createMcpServer(agent: Agent): McpServer {
  const server = new McpServer({ name: 'housecallpro-mcp', version: '0.3.0' });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.type === 'read' },
      },
      (input: Record<string, unknown>) => runTool(agent, tool, input),
    );
  }
  return server;
}

export interface AppOptions {
  /**
   * Called after a Slack click is verified, before Slack gets its 200. Must return fast (Slack's 3s limit).
   * Long-running server: process in-process without awaiting. Serverless (Netlify): hand off to a background function.
   */
  dispatchSlackInteraction: (req: { rawBody: string; timestamp: string; signature: string; host: string; payload: Record<string, any> }) => Promise<void>;
}

export function createApp(opts: AppOptions): express.Express {
  const app = express();

  // serverless-http (Netlify) fills req.headers but not req.rawHeaders, which the MCP SDK's
  // Node->Web request conversion reads. Rebuild rawHeaders when missing.
  app.use((req, _res, next) => {
    if (!req.rawHeaders?.length) {
      req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) =>
        v === undefined ? [] : Array.isArray(v) ? v.flatMap((x) => [k, x]) : [k, String(v)],
      );
    }
    next();
  });

  app.use(express.json({ limit: '6mb' }));

  app.get('/', (_req, res) => {
    res.json({ name: 'housecallpro-mcp', mcp_endpoint: '/mcp', health: '/health' });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, hcp_mock: config.hcp.mock, hcp_mock_writes: config.hcp.mock || config.hcp.mockWrites, tools: tools.map((t) => `${t.name} (${t.type})`) });
  });

  app.post('/mcp', requireAgent, async (req, res) => {
    const server = createMcpServer(res.locals.agent as Agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // Job request workflow: {"text": "..."} or {"pdf_base64": "..."} -> Claude extraction -> Slack approval.
  app.post('/workflows/job-request', requireAgent, async (req, res) => {
    const agent = res.locals.agent as Agent;
    if (!canCall(agent.role, 'write')) {
      const message = `Permission denied: agent "${agent.name}" has role "${agent.role}"; the job request workflow needs a writer key.`;
      await logToolCall({ agent: agent.name, tool: WORKFLOW_NAME, inputs: {}, result: { error: message }, status: 'rejected_permission', latency_ms: 0 });
      res.status(403).json({ error: message });
      return;
    }
    const { text, pdf_base64 } = (req.body ?? {}) as { text?: unknown; pdf_base64?: unknown };
    let input: JobRequestInput;
    if (typeof pdf_base64 === 'string' && pdf_base64.length > 0) input = { pdfBase64: pdf_base64.replace(/\s/g, '') };
    else if (typeof text === 'string' && text.trim().length > 0) input = { text };
    else {
      res.status(400).json({ error: 'Send JSON with either "text" (email body) or "pdf_base64" (base64-encoded PDF).' });
      return;
    }
    try {
      res.status(202).json(await submitJobRequest(agent.name, input));
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? 502 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  // Slack slash command /hcp-agent: admins create, list, re-role and revoke API keys from Slack.
  // Answered synchronously (one quick DB call), well inside Slack's 3 second limit.
  app.post('/slack/commands', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySlackSignature(rawBody, req.header('x-slack-request-timestamp'), req.header('x-slack-signature'))) {
      res.status(401).send('invalid signature');
      return;
    }
    res.json(await handleAgentCommand(new URLSearchParams(rawBody), req.get('host') ?? ''));
  });

  // Slack interactivity (Approve / Reject buttons). Raw body is needed to verify the signature.
  app.post('/slack/actions', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const timestamp = req.header('x-slack-request-timestamp') ?? '';
    const signature = req.header('x-slack-signature') ?? '';
    const payload = parseSlackInteraction(rawBody, timestamp, signature);
    if (!payload) {
      res.status(401).send('invalid signature');
      return;
    }
    try {
      await opts.dispatchSlackInteraction({ rawBody, timestamp, signature, host: req.get('host') ?? '', payload });
    } catch (err) {
      console.error('Slack dispatch failed:', err);
    }
    // Slack requires a 200 within 3 seconds; the actual work runs asynchronously.
    res.status(200).send('');
  });

  // Stateless server: no server-initiated SSE stream and no sessions to delete.
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server, use POST)' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
