/** One source-level definition recovered by a language parser. */
export interface ParsedDef {
  name: string
  container?: string
  kind: string
  /** 1-based inclusive start line. */
  from: number
  /** 1-based inclusive end line. */
  to: number
  /** Definition text before its body, with whitespace normalised. */
  signature: string
}

/** Language-neutral facts recovered from one source file. */
export interface ParsedFile {
  defs: ParsedDef[]
  /** Identifiers used by the file, excluding its own definitions. */
  refs: string[]
  /** Imported names or paths as written in source. */
  imports: string[]
}

/** Synchronous once its language has been loaded; undefined means unsupported or unavailable. */
export type FileParser = (path: string, text: string) => ParsedFile | undefined
