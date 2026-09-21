import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'c',
  extensions: ['.c', '.h'],
  query: `
    (function_definition
      declarator: (function_declarator declarator: (identifier) @def.name)) @def
    (function_definition
      declarator: (pointer_declarator
        declarator: (function_declarator declarator: (identifier) @def.name))) @def

    (struct_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def
    (enum_specifier name: (type_identifier) @def.name body: (enumerator_list)) @def
    (union_specifier name: (type_identifier) @def.name body: (field_declaration_list)) @def
    (type_definition declarator: (type_identifier) @def.name) @def

    (declaration
      (storage_class_specifier "static")
      declarator: (init_declarator declarator: (identifier) @def.name)) @def
    (declaration
      (storage_class_specifier "static")
      declarator: (identifier) @def.name) @def
    (declaration
      (type_qualifier "const")
      declarator: (init_declarator declarator: (identifier) @def.name)) @def
    (declaration
      (type_qualifier "const")
      declarator: (identifier) @def.name) @def

    (preproc_def name: (identifier) @def.name) @def
    (preproc_function_def name: (identifier) @def.name) @def

    (call_expression function: (identifier) @ref)
    (field_expression field: (field_identifier) @ref)
    (type_identifier) @ref
    (preproc_include path: (_) @import)
  `,
}
