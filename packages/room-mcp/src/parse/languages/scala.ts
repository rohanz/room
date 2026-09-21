import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'scala',
  extensions: ['.scala', '.sc'],
  query: `
    (class_definition name: (identifier) @def.name) @def
    (object_definition name: (identifier) @def.name) @def
    (trait_definition name: (identifier) @def.name) @def
    (type_definition name: (type_identifier) @def.name) @def
    (ERROR . (identifier) . (identifier) @def.name) @def

    (class_definition name: (identifier) @def.container
      body: (template_body (function_definition name: (identifier) @def.name) @def))
    (class_definition name: (identifier) @def.container
      body: (template_body (function_declaration name: (identifier) @def.name) @def))
    (object_definition name: (identifier) @def.container
      body: (template_body (function_definition name: (identifier) @def.name) @def))
    (object_definition name: (identifier) @def.container
      body: (template_body (function_declaration name: (identifier) @def.name) @def))
    (trait_definition name: (identifier) @def.container
      body: (template_body (function_definition name: (identifier) @def.name) @def))
    (trait_definition name: (identifier) @def.container
      body: (template_body (function_declaration name: (identifier) @def.name) @def))

    (object_definition name: (identifier) @def.container
      body: (template_body (val_definition pattern: (identifier) @def.name) @def))

    (call_expression function: (identifier) @ref)
    (field_expression field: (identifier) @ref)
    (type_identifier) @ref
    (import_declaration path: (stable_identifier) @import)
  `,
  keywords: ['this', 'super'],
}
