import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'php',
  extensions: ['.php'],
  query: String.raw`
    (program (function_definition name: (name) @def.name) @def)
    (namespace_definition
      name: (namespace_name (name) @def.container)
      body: (compound_statement (function_definition name: (name) @def.name) @def))
    (class_declaration name: (name) @def.name) @def
    (interface_declaration name: (name) @def.name) @def
    (trait_declaration name: (name) @def.name) @def
    (enum_declaration name: (name) @def.name) @def

    (class_declaration
      name: (name) @def.container
      body: (declaration_list (method_declaration name: (name) @def.name) @def))
    (interface_declaration
      name: (name) @def.container
      body: (declaration_list (method_declaration name: (name) @def.name) @def))
    (trait_declaration
      name: (name) @def.container
      body: (declaration_list (method_declaration name: (name) @def.name) @def))
    (enum_declaration
      name: (name) @def.container
      body: (enum_declaration_list (method_declaration name: (name) @def.name) @def))
    (class_declaration
      name: (name) @def.container
      body: (declaration_list (use_declaration
        (use_list (use_as_clause (name) @ref (name) @def.name) @def))))

    (program (const_declaration (const_element (name) @def.name) @def))
    (class_declaration
      name: (name) @def.container
      body: (declaration_list (const_declaration (const_element (name) @def.name) @def)))
    (interface_declaration
      name: (name) @def.container
      body: (declaration_list (const_declaration (const_element (name) @def.name) @def)))
    (trait_declaration
      name: (name) @def.container
      body: (declaration_list (const_declaration (const_element (name) @def.name) @def)))

    (namespace_use_clause (qualified_name) @import)
    (namespace_aliasing_clause (name) @import)
    (require_expression (string (string_content) @import))
    (require_once_expression (string (string_content) @import))
    (require_expression (encapsed_string (string_content) @import))
    (require_once_expression (encapsed_string (string_content) @import))

    (namespace_use_clause (qualified_name (name) @ref))
    (namespace_aliasing_clause (name) @ref)
    (function_call_expression function: (name) @ref)
    (member_call_expression name: (name) @ref)
    (member_access_expression name: (name) @ref)
    (nullsafe_member_call_expression name: (name) @ref)
    (nullsafe_member_access_expression name: (name) @ref)
    (scoped_call_expression name: (name) @ref)
    (named_type (name) @ref)
    (use_declaration (name) @ref)
  `,
}
