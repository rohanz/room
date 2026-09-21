/** Declarative tree-sitter configuration supplied by each supported language. */
export interface LanguageSpec {
  /** tree-sitter-wasms basename without the `tree-sitter-` prefix or `.wasm` suffix. */
  grammar: string
  /** Lowercase extensions, including the leading dot. */
  extensions: string[]
  /** Query captures are limited to @def, @def.name, optional @def.container, @ref, and @import. */
  query: string
  /** Identifiers to omit from references after query collection. */
  keywords?: string[]
}
