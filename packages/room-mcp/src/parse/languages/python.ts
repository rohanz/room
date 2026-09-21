import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'python',
  extensions: ['.py', '.pyi'],
  query: String.raw`
    (class_definition name: (identifier) @def.name) @def

    (module (function_definition name: (identifier) @def.name) @def)
    (module (decorated_definition definition: (function_definition name: (identifier) @def.name) @def))
    (class_definition
      name: (identifier) @def.container
      body: (block (function_definition name: (identifier) @def.name) @def))
    (class_definition
      name: (identifier) @def.container
      body: (block (decorated_definition definition: (function_definition name: (identifier) @def.name) @def)))

    ((module
      (expression_statement
        (assignment left: (identifier) @def.name) @def))
      (#match? @def.name "^[A-Z_][A-Z0-9_]*$"))

    (import_statement name: (dotted_name) @import)
    (import_statement name: (aliased_import name: (dotted_name) @import alias: (identifier) @import))
    (import_from_statement module_name: (dotted_name) @import)
    (import_from_statement name: (dotted_name) @import)
    (import_from_statement name: (aliased_import name: (dotted_name) @import alias: (identifier) @import))

    (import_statement name: (dotted_name (identifier) @ref))
    (import_statement name: (aliased_import name: (dotted_name (identifier) @ref) alias: (identifier) @ref))
    (import_from_statement name: (dotted_name (identifier) @ref))
    (import_from_statement name: (aliased_import name: (dotted_name (identifier) @ref) alias: (identifier) @ref))
    (call function: (identifier) @ref)
    (call function: (attribute attribute: (identifier) @ref))
    (attribute attribute: (identifier) @ref)
    (type (identifier) @ref)
    (class_definition superclasses: (argument_list (identifier) @ref))
  `,
  keywords: ['self', 'cls'],
}
