import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'kotlin',
  extensions: ['.kt', '.kts'],
  query: `
    (class_declaration (type_identifier) @def.name) @def
    (object_declaration (type_identifier) @def.name) @def
    (type_alias (type_identifier) @def.name) @def

    (source_file (function_declaration
      (simple_identifier) @def.name
      (function_body)? @def.body) @def)
    (class_declaration (type_identifier) @def.container
      (class_body (function_declaration
        (simple_identifier) @def.name
        (function_body)? @def.body) @def))
    (class_declaration (type_identifier) @def.container
      (enum_class_body (function_declaration
        (simple_identifier) @def.name
        (function_body)? @def.body) @def))
    (object_declaration (type_identifier) @def.container
      (class_body (function_declaration
        (simple_identifier) @def.name
        (function_body)? @def.body) @def))
    (companion_object (type_identifier) @def.container
      (class_body (function_declaration
        (simple_identifier) @def.name
        (function_body)? @def.body) @def))
    (class_declaration (type_identifier) @def.container
      (class_body (companion_object .
        (class_body (function_declaration
          (simple_identifier) @def.name
          (function_body)? @def.body) @def))))

    (class_declaration (type_identifier) @def.container
      (class_body (secondary_constructor "constructor" @def.name) @def))

    (source_file
      (property_declaration
        (binding_pattern_kind)
        (variable_declaration (simple_identifier) @def.name)) @def)
    ((class_declaration (type_identifier) @def.container
       (class_body
         (property_declaration
           (modifiers (property_modifier))
           (variable_declaration (simple_identifier) @def.name)) @def))
     (#match? @def "^const"))
    ((object_declaration (type_identifier) @def.container
       (class_body
         (property_declaration
           (modifiers (property_modifier))
           (variable_declaration (simple_identifier) @def.name)) @def))
     (#match? @def "^const"))
    ((class_declaration (type_identifier) @def.container
       (class_body (companion_object
         (class_body
           (property_declaration
             (modifiers (property_modifier))
             (variable_declaration (simple_identifier) @def.name)) @def))))
     (#match? @def "^const"))

    (call_expression (simple_identifier) @ref)
    (navigation_suffix (simple_identifier) @ref)
    (user_type (type_identifier) @ref)
    (import_header (identifier) @import)
  `,
  keywords: ['this', 'super'],
}
