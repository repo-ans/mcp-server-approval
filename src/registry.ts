// Single place that wires connectors and workflows into the core. Every entry point
// (Express app, Netlify api function, Netlify background worker) imports this, so approvals
// can execute in any process. To add a connector, import its tools and add them to `tools`.
import { registerAction } from './core/approval.js';
import type { AnyTool } from './core/types.js';
import { tools as hcpTools } from './connectors/housecallpro/tools.js';
import { jobRequestTool } from './workflows/job-request.js'; // also registers the "job_request" approvable action

export const tools: AnyTool[] = [...hcpTools, jobRequestTool];

// Every write tool is an approvable action; its handler runs only after approval in Slack.
// (Tools that submit their own approval, like submit_job_request, register their action themselves.)
for (const tool of tools) {
  if (tool.type === 'write' && !tool.submitsOwnApproval) {
    registerAction(tool.name, { run: (inputs, ctx) => tool.handler(inputs, ctx) });
  }
}
