import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'java',
  extensions: ['.java'],
  query: `
    (class_declaration name: (identifier) @def.name) @def
    (interface_declaration name: (identifier) @def.name) @def
    (enum_declaration name: (identifier) @def.name) @def
    (record_declaration name: (identifier) @def.name) @def

    (class_declaration name: (identifier) @def.container
      body: (class_body (method_declaration name: (identifier) @def.name) @def))
    (interface_declaration name: (identifier) @def.container
      body: (interface_body (method_declaration name: (identifier) @def.name) @def))
    (enum_declaration name: (identifier) @def.container
      body: (enum_body (enum_body_declarations
        (method_declaration name: (identifier) @def.name) @def)))
    (record_declaration name: (identifier) @def.container
      body: (class_body (method_declaration name: (identifier) @def.name) @def))

    (class_declaration name: (identifier) @def.container
      body: (class_body (constructor_declaration name: (identifier) @def.name) @def))
    (enum_declaration name: (identifier) @def.container
      body: (enum_body (enum_body_declarations
        (constructor_declaration name: (identifier) @def.name) @def)))
    (record_declaration name: (identifier) @def.container
      body: (class_body (compact_constructor_declaration name: (identifier) @def.name) @def))

    (class_declaration name: (identifier) @def.container
      body: (class_body
        (field_declaration
          (modifiers "static" "final")
          declarator: (variable_declarator name: (identifier) @def.name)) @def))
    (interface_declaration name: (identifier) @def.container
      body: (interface_body
        (constant_declaration
          declarator: (variable_declarator name: (identifier) @def.name)) @def))

    (method_invocation name: (identifier) @ref)
    (field_access field: (identifier) @ref)
    (type_identifier) @ref
    (import_declaration (scoped_identifier) @import)
    (import_declaration (identifier) @import)
  `,
  keywords: ['this', 'super'],
}
