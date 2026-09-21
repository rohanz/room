import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'typescript',
  extensions: ['.ts', '.mts', '.cts'],
  query: String.raw`
    (function_declaration name: (identifier) @def.name) @def
    (function_signature name: (identifier) @def.name) @def
    (generator_function_declaration name: (identifier) @def.name) @def
    (class_declaration name: (type_identifier) @def.name) @def
    (abstract_class_declaration name: (type_identifier) @def.name) @def
    (interface_declaration name: (type_identifier) @def.name) @def
    (type_alias_declaration name: (type_identifier) @def.name) @def
    (enum_declaration name: (identifier) @def.name) @def

    (class_declaration
      name: (type_identifier) @def.container
      body: (class_body (method_definition name: (property_identifier) @def.name) @def))
    (abstract_class_declaration
      name: (type_identifier) @def.container
      body: (class_body (method_definition name: (property_identifier) @def.name) @def))
    (abstract_class_declaration
      name: (type_identifier) @def.container
      body: (class_body (abstract_method_signature name: (property_identifier) @def.name) @def))
    (interface_declaration
      name: (type_identifier) @def.container
      body: (interface_body (method_signature name: (property_identifier) @def.name) @def))

    (program (lexical_declaration (variable_declarator name: (identifier) @def.name) @def))
    (program (variable_declaration (variable_declarator name: (identifier) @def.name) @def))
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @def.name) @def))
    (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @def.name) @def))

    (import_statement source: (string (string_fragment) @import))
    (import_statement (import_clause (identifier) @import))
    (import_specifier name: (identifier) @import)
    (import_specifier alias: (identifier) @import)
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
    (new_expression constructor: [(identifier) (type_identifier)] @ref)
    (type_identifier) @ref
  `,
  keywords: ['require'],
}
