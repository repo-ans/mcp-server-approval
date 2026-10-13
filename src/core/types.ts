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
  handler: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
  /** Optional cross-field check run before a write is sent for approval. Throw to reject the call. */
  validate?: (input: z.infer<z.ZodObject<S>>) => void;
}

/** Identity helper that keeps handler input typed from the zod shape. */
export function defineTool<S extends z.ZodRawShape>(tool: ToolDef<S>): ToolDef<S> {
  return tool;
}

export type AnyTool = ToolDef<any>;
