import type { z } from 'zod';

export type ToolType = 'read' | 'write';
export type Role = 'read_only' | 'writer';

/** The authenticated caller, resolved from the API key. */
export interface Agent {
  name: string;
  role: Role;
}

/** A tool exposed over MCP. Connectors export an array of these; core handles auth, approval and logging. */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  type: ToolType;
  inputSchema: S;
  handler: (input: z.infer<z.ZodObject<S>>, ctx: { agent: string }) => Promise<unknown>;
  /** Optional cross-field check run before a write is sent for approval. Throw to reject the call. */
  validate?: (input: z.infer<z.ZodObject<S>>) => void;
  /**
   * Write tools are normally queued for approval by the core and their handler runs after Approve.
   * Set this when the handler itself prepares and submits the approval (e.g. a workflow that must
   * call Claude first); the core then runs the handler immediately (writer role still required).
   */
  submitsOwnApproval?: boolean;
}

/** Identity helper that keeps handler input typed from the zod shape. */
export function defineTool<S extends z.ZodRawShape>(tool: ToolDef<S>): ToolDef<S> {
  return tool;
}

export type AnyTool = ToolDef<any>;
