import { AGENT_INSTRUCTIONS } from '@room/room-mcp/prompt'

/** First-turn preamble: the same text the MCP server hands to Claude Code. */
export function preamble(name: string): string {
  return AGENT_INSTRUCTIONS(name)
}
