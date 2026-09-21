import type { LanguageSpec } from '../spec.js'

export const spec: LanguageSpec = {
  grammar: 'ruby',
  extensions: ['.rb'],
  query: String.raw`
    (module name: (constant) @def.name) @def
    (class name: (constant) @def.name) @def

    (program (method name: (identifier) @def.name) @def)
    (program (singleton_method name: (identifier) @def.name) @def)
    (module
      name: (constant) @def.container
      body: (body_statement (method name: (identifier) @def.name) @def))
    (module
      name: (constant) @def.container
      body: (body_statement (singleton_method name: (identifier) @def.name) @def))
    (class
      name: (constant) @def.container
      body: (body_statement (method name: (identifier) @def.name) @def))
    (class
      name: (constant) @def.container
      body: (body_statement (singleton_method name: (identifier) @def.name) @def))
    (class
      name: (constant) @def.container
      body: (body_statement (singleton_class value: (self)
        body: (body_statement (method name: (identifier) @def.name) @def))))

    ((class
      name: (constant) @def.container
      body: (body_statement (call
        method: (identifier) @_accessor
        arguments: (argument_list (simple_symbol) @def.name.bare)) @def))
      (#match? @_accessor "^attr_(reader|writer|accessor)$"))

    (program (assignment left: (constant) @def.name) @def)
    (module
      name: (constant) @def.container
      body: (body_statement (assignment left: (constant) @def.name) @def))
    (class
      name: (constant) @def.container
      body: (body_statement (assignment left: (constant) @def.name) @def))

    (call
      method: (identifier) @_require
      arguments: (argument_list (string (string_content) @import))
      (#match? @_require "^(require|require_relative)$"))

    (call method: (identifier) @ref)
    (call receiver: (_) method: (identifier) @ref)
    (class superclass: (superclass (constant) @ref))
  `,
  keywords: ['require', 'require_relative', 'new'],
}
