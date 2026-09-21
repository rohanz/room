import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'swift',
  extensions: ['.swift'],
  query: `
    (class_declaration "class" name: (type_identifier) @def.name) @def
    (class_declaration "struct" name: (type_identifier) @def.name) @def
    (class_declaration "enum" name: (type_identifier) @def.name) @def
    (class_declaration "actor" name: (type_identifier) @def.name) @def
    (class_declaration "extension" name: (_) @def.name) @def
    (protocol_declaration name: (type_identifier) @def.name) @def
    (typealias_declaration name: (type_identifier) @def.name) @def

    (source_file (function_declaration name: (simple_identifier) @def.name) @def)
    (class_declaration name: (_) @def.container
      body: (class_body (function_declaration name: (simple_identifier) @def.name) @def))
    (protocol_declaration name: (type_identifier) @def.container
      body: (protocol_body (protocol_function_declaration name: (simple_identifier) @def.name) @def))

    (class_declaration name: (_) @def.container
      body: (class_body (init_declaration "init" @def.name) @def))

    (source_file
      (property_declaration (value_binding_pattern "let")
        name: (pattern bound_identifier: (simple_identifier) @def.name)) @def)
    (class_declaration name: (_) @def.container
      body: (class_body
        (property_declaration (value_binding_pattern "let")
          name: (pattern bound_identifier: (simple_identifier) @def.name)) @def))

    (call_expression (simple_identifier) @ref)
    (navigation_suffix suffix: (simple_identifier) @ref)
    (user_type (type_identifier) @ref)
    (import_declaration (identifier) @import)
  `,
  keywords: ['self', 'super'],
}
