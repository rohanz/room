import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],
  query: String.raw`
    (function_declaration name: (identifier) @def.name) @def
    (generator_function_declaration name: (identifier) @def.name) @def
    (class_declaration name: (identifier) @def.name) @def
    (export_statement "default" @def.name value: (function_expression)) @def

    (class_declaration
      name: (identifier) @def.container
      body: (class_body (method_definition name: (property_identifier) @def.name) @def))

    (program (lexical_declaration (variable_declarator name: (identifier) @def.name) @def))
    (program (variable_declaration (variable_declarator name: (identifier) @def.name) @def))
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @def.name) @def))
    (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @def.name) @def))

    (import_statement source: (string (string_fragment) @import))
    (import_statement (import_clause (identifier) @import))
    (import_specifier name: (identifier) @import)
    (import_specifier alias: (identifier) @import)
    (export_statement
      (export_clause (export_specifier name: (identifier) @def.name @ref.external .))
      source: (string (string_fragment) @import)) @def
    (export_statement
      (export_clause (export_specifier
        name: (identifier) @ref.external
        alias: (identifier) @def.name))
      source: (string (string_fragment) @import)) @def
    (call_expression
      function: (identifier) @_require
      arguments: (arguments (string (string_fragment) @import))
      (#eq? @_require "require"))

    (import_statement (import_clause (identifier) @ref))
    (import_specifier name: (identifier) @ref)
    (import_specifier alias: (identifier) @ref)
    (call_expression function: (identifier) @ref)
    (call_expression function: (member_expression property: (property_identifier) @ref))
    (member_expression property: (property_identifier) @ref)
    (new_expression constructor: (identifier) @ref)
    (class_heritage (identifier) @ref)
  `,
  keywords: ['require'],
}
