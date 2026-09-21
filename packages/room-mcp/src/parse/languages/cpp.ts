import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'cpp',
  extensions: ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
  query: `
    (translation_unit (function_definition
      declarator: (function_declarator declarator: (identifier) @def.name)) @def)

    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (function_definition
        declarator: (function_declarator declarator: (identifier) @def.name)) @def))

    (class_specifier name: (type_identifier) @def.container
      body: (field_declaration_list (function_definition
        declarator: (function_declarator declarator: (field_identifier) @def.name)) @def))
    (struct_specifier name: (type_identifier) @def.container
      body: (field_declaration_list (function_definition
        declarator: (function_declarator declarator: (field_identifier) @def.name)) @def))

    (function_definition declarator: (function_declarator
      declarator: (qualified_identifier
        scope: (namespace_identifier) @def.container
        name: (identifier) @def.name))) @def
    (function_definition declarator: (function_declarator
      declarator: (qualified_identifier
        name: (qualified_identifier
          scope: (namespace_identifier) @def.container
          name: (identifier) @def.name)))) @def

    (translation_unit (class_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def)
    (translation_unit (struct_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def)
    (translation_unit (enum_specifier name: (type_identifier) @def.name body: (enumerator_list)) @def)
    (translation_unit (union_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def)
    (translation_unit (alias_declaration name: (type_identifier) @def.name) @def)
    (translation_unit (type_definition declarator: (type_identifier) @def.name) @def)

    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (class_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def))
    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (struct_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def))
    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (enum_specifier name: (type_identifier) @def.name body: (enumerator_list)) @def))
    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (union_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def))
    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (alias_declaration name: (type_identifier) @def.name) @def))
    (namespace_definition name: (namespace_identifier) @def.container
      body: (declaration_list (type_definition declarator: (type_identifier) @def.name) @def))

    (declaration (type_qualifier "const")
      declarator: (init_declarator declarator: (identifier) @def.name)) @def
    (declaration (storage_class_specifier "static")
      declarator: (init_declarator declarator: (identifier) @def.name)) @def

    (preproc_def name: (identifier) @def.name) @def
    (preproc_function_def name: (identifier) @def.name) @def

    (call_expression function: (identifier) @ref)
    (call_expression function: (field_expression field: (field_identifier) @ref))
    (field_expression field: (field_identifier) @ref)
    (type_identifier) @ref
    (preproc_include path: (_) @import)
  `,
  keywords: ['this'],
}
