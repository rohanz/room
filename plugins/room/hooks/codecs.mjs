// Explicit hook-only registry. These generated entries never load the MCP server bundle.
import { claudeHookCodec } from './claude-hook-codec.mjs'
import { codexHookCodec, compatibilityHookCodec } from './codex-hook-codec.mjs'

export const compatibilityCodec = compatibilityHookCodec()
export const hookCodecFor = host => host === 'claude' ? claudeHookCodec : host === 'codex' ? codexHookCodec : compatibilityHookCodec(host)

// Preserve the existing executable contract, including no-flag default and unknown explicit names.
export function startupHookCodec(argv) {
  const flag = argv.indexOf('--host')
  const host = flag >= 0 && argv[flag + 1] ? argv[flag + 1] : 'codex'
  return { host, codec: hookCodecFor(host) }
}
