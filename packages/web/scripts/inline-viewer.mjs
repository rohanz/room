import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Inline Vite's two local assets. The installed file must execute without HTTP assets. */
export function inlineViewer(html, readAsset) {
  let scripts = 0, styles = 0
  const asset = name => {
    if (!/^\/assets\/[\w.-]+\.(?:js|css)$/.test(name)) throw new Error(`unexpected viewer asset: ${name}`)
    return readAsset(name.slice(1))
  }
  const out = html
    .replace(/<script\b([^>]*)\bsrc="([^"]+)"([^>]*)><\/script>/gi, (_tag, before, name, after) => {
      if (!/\btype="module"/.test(before + after)) throw new Error('viewer script is not a module')
      scripts++
      return `<script type="module">${asset(name).replace(/<\/script/gi, '<\\/script')}</script>`
    })
    .replace(/<link\b[^>]*>/gi, tag => {
      if (/\brel="stylesheet"/.test(tag) && /\bhref="\/assets\//.test(tag)) {
        const name = /\bhref="([^"]+)"/.exec(tag)?.[1]
        if (!name) throw new Error('missing stylesheet name')
        styles++
        return `<style>${asset(name).replace(/<\/style/gi, '<\\/style')}</style>`
      }
      return '' // icons, font origins, preloads and remote styles belong only to the hosted view
    })
  if (scripts !== 1 || styles !== 1 || /<(?:script|link|img|iframe|source|video|audio)\b[^>]*(?:src|href)=/i.test(out)) throw new Error('viewer is not self-contained')
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const viewer = inlineViewer(html, name => fs.readFileSync(path.join(dist, name), 'utf8'))
  fs.writeFileSync(path.join(dist, 'viewer.html'), viewer)
  console.log('wrote packages/web/dist/viewer.html')
}
