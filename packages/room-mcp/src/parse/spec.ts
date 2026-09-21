/** Declarative tree-sitter configuration supplied by each supported language. */
export interface LanguageSpec {
  /** tree-sitter-wasms basename without the `tree-sitter-` prefix or `.wasm` suffix. */
  grammar: string
  /** Lowercase extensions, including the leading dot. */
  extensions: string[]
  /**
   * Query captures use @def with @def.name (or @def.name.bare), optional
   * @def.container and @def.body, @ref (or @ref.external), and @import.
   */
  query: string
  /** Identifiers to omit from references after query collection. */
  keywords?: string[]
}
