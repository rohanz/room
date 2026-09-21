import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'go',
  extensions: ['.go'],
  query: `
    (function_declaration name: (identifier) @def.name) @def

    (method_declaration
      receiver: (parameter_list (parameter_declaration type: (type_identifier) @def.container))
      name: (field_identifier) @def.name) @def
    (method_declaration
      receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @def.container)))
      name: (field_identifier) @def.name) @def

    (type_spec name: (type_identifier) @def.name) @def
    (type_alias name: (type_identifier) @def.name) @def
    (const_spec name: (identifier) @def.name) @def
    (var_spec name: (identifier) @def.name) @def

    (call_expression function: (identifier) @ref)
    (call_expression function: (selector_expression field: (field_identifier) @ref))
    (selector_expression field: (field_identifier) @ref)
    (type_identifier) @ref
    (import_spec path: (interpreted_string_literal) @import)
    (import_spec path: (raw_string_literal) @import)
  `,
}
