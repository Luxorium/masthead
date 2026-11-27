import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { VERSION } from '../../../shared/protocol.js';
import type { JSONSchema, ToolDef } from '../types.js';

/** The MCP server name Masthead's tools appear under: the model sees them as mcp__masthead__<name>. */
export const MCP_NAME = 'masthead';

/**
 * Turns one property of a JSON Schema back into zod, for the SDK's in-process MCP helper, which takes
 * zod shapes. Only what the team tools use: string (with min/max length and enum), number, integer,
 * boolean. Anything else is accepted as is.
 */
function zodFor(p: JSONSchema): z.ZodTypeAny {
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === 'string')) {
    return z.enum(p.enum as [string, ...string[]]);
  }
  switch (p.type) {
    case 'string': {
      let s = z.string();
      if (typeof p.minLength === 'number') s = s.min(p.minLength);
      if (typeof p.maxLength === 'number') s = s.max(p.maxLength);
      return s;
    }
    case 'integer':
    case 'number': {
      let n = p.type === 'integer' ? z.number().int() : z.number();
      if (typeof p.minimum === 'number') n = n.min(p.minimum);
      if (typeof p.maximum === 'number') n = n.max(p.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    default:
      return z.any();
  }
}

export function zodShape(schema: JSONSchema): Record<string, z.ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, p] of Object.entries(props)) {
    let t = zodFor(p);
    if (typeof p.description === 'string') t = t.describe(p.description);
    shape[name] = required.has(name) ? t : t.optional();
  }
  return shape;
}

/** One in-process MCP server holding a session's team tools. */
export function mcpServer(defs: ToolDef[]): McpSdkServerConfigWithInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = defs.map((d) =>
    tool(d.name, d.description, zodShape(d.input), async (args) => {
      const text = await d.run(args);
      return { content: [{ type: 'text' as const, text }], isError: text.startsWith('Error:') };
    }),
  );
  return createSdkMcpServer({ name: MCP_NAME, version: VERSION, alwaysLoad: true, tools });
}
