import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'rust',
  extensions: ['.rs'],
  query: `
    (source_file (function_item name: (identifier) @def.name) @def)

    (impl_item type: (type_identifier) @def.container
      body: (declaration_list (function_item name: (identifier) @def.name) @def))
    (impl_item type: (generic_type type: (type_identifier) @def.container)
      body: (declaration_list (function_item name: (identifier) @def.name) @def))
    (impl_item type: (scoped_type_identifier name: (type_identifier) @def.container)
      body: (declaration_list (function_item name: (identifier) @def.name) @def))

    (trait_item name: (type_identifier) @def.container
      body: (declaration_list (function_signature_item name: (identifier) @def.name) @def))
    (trait_item name: (type_identifier) @def.container
      body: (declaration_list (function_item name: (identifier) @def.name) @def))

    (struct_item name: (type_identifier) @def.name) @def
    (enum_item name: (type_identifier) @def.name) @def
    (union_item name: (type_identifier) @def.name) @def
    (trait_item name: (type_identifier) @def.name) @def
    (type_item name: (type_identifier) @def.name) @def
    (const_item name: (identifier) @def.name) @def
    (static_item name: (identifier) @def.name) @def
    (macro_definition name: (identifier) @def.name) @def

    (mod_item name: (identifier) @def.container
      body: (declaration_list (function_item name: (identifier) @def.name) @def))

    (call_expression function: (identifier) @ref)
    (scoped_identifier name: (identifier) @ref)
    (use_list (identifier) @ref)
    (use_as_clause path: (identifier) @ref)
    (macro_invocation macro: (identifier) @ref)
    (call_expression function: (field_expression field: (field_identifier) @ref))
    (field_expression field: (field_identifier) @ref)
    (type_identifier) @ref
    (use_declaration argument: (_) @import)
  `,
  keywords: ['self', 'Self', 'super', 'crate'],
}
