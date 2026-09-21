import { spec as rust } from './languages/rust.js'
import { spec as go } from './languages/go.js'
import { spec as c } from './languages/c.js'
import { spec as cpp } from './languages/cpp.js'
import { spec as java } from './languages/java.js'
import { spec as kotlin } from './languages/kotlin.js'
import { spec as csharp } from './languages/csharp.js'
import { spec as swift } from './languages/swift.js'
import { spec as scala } from './languages/scala.js'
import { spec as python } from './languages/python.js'
import { spec as javascript } from './languages/javascript.js'
import { spec as typescript } from './languages/typescript.js'
import { spec as tsx } from './languages/tsx.js'
import { spec as ruby } from './languages/ruby.js'
import { spec as php } from './languages/php.js'
import type { LanguageSpec } from './spec.js'

/** Every language supported by the MCP parser, in deterministic bundle order. */
export const languageSpecs: readonly LanguageSpec[] = [
  rust, go, c, cpp, java, kotlin, csharp, swift, scala,
  python, javascript, typescript, tsx, ruby, php,
]

/** Resolve a source path to its language specification. */
export function specForPath(path: string): LanguageSpec | undefined {
  const lower = path.toLowerCase()
  return languageSpecs.find(spec => spec.extensions.some(extension => lower.endsWith(extension)))
}

export type { LanguageSpec } from './spec.js'
