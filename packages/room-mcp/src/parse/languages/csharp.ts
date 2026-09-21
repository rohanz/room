import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'c_sharp',
  extensions: ['.cs'],
  query: `
    (class_declaration name: (identifier) @def.name) @def
    (interface_declaration name: (identifier) @def.name) @def
    (enum_declaration name: (identifier) @def.name) @def
    (struct_declaration name: (identifier) @def.name) @def
    (record_declaration name: (identifier) @def.name) @def
    (record_struct_declaration name: (identifier) @def.name) @def

    (class_declaration name: (identifier) @def.container
      body: (declaration_list (method_declaration name: (identifier) @def.name) @def))
    (interface_declaration name: (identifier) @def.container
      body: (declaration_list (method_declaration name: (identifier) @def.name) @def))
    (struct_declaration name: (identifier) @def.container
      body: (declaration_list (method_declaration name: (identifier) @def.name) @def))
    (record_declaration name: (identifier) @def.container
      body: (declaration_list (method_declaration name: (identifier) @def.name) @def))
    (record_struct_declaration name: (identifier) @def.container
      body: (declaration_list (method_declaration name: (identifier) @def.name) @def))

    (class_declaration name: (identifier) @def.container
      body: (declaration_list (constructor_declaration name: (identifier) @def.name) @def))
    (struct_declaration name: (identifier) @def.container
      body: (declaration_list (constructor_declaration name: (identifier) @def.name) @def))
    (record_declaration name: (identifier) @def.container
      body: (declaration_list (constructor_declaration name: (identifier) @def.name) @def))
    (record_struct_declaration name: (identifier) @def.container
      body: (declaration_list (constructor_declaration name: (identifier) @def.name) @def))

    (class_declaration name: (identifier) @def.container
      body: (declaration_list
        (field_declaration (modifier "const")
          (variable_declaration (variable_declarator (identifier) @def.name))) @def))
    (struct_declaration name: (identifier) @def.container
      body: (declaration_list
        (field_declaration (modifier "const")
          (variable_declaration (variable_declarator (identifier) @def.name))) @def))

    (invocation_expression function: (identifier) @ref)
    (member_access_expression name: (identifier) @ref)
    (generic_name (identifier) @ref)
    (parameter type: (identifier) @ref)
    (method_declaration type: (identifier) @ref)
    (variable_declaration type: (identifier) @ref)
    (object_creation_expression type: (identifier) @ref)
    (using_directive (qualified_name) @import)
    (using_directive (identifier) @import)
  `,
  keywords: ['this', 'base'],
}
