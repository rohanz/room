// Bump appends; retirement requires an explicit maintainer action outside the support window.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const parts = tag => {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`invalid compatibility tag: ${tag}`)
  return tag.slice(1).split('.').map(Number)
}
export function validatePins(pins) {
  if (!Array.isArray(pins) || !pins.length) throw new Error('compatibility pins must be a nonempty array')
  const seen = new Set()
  for (const pin of pins) {
    parts(pin.tag)
    if (seen.has(pin.tag)) throw new Error(`duplicate compatibility tag: ${pin.tag}`)
    seen.add(pin.tag)
    if (pin.commit !== undefined && !/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`invalid commit for ${pin.tag}`)
    // A release whose server and relay cannot start on a platform (0.17.0 on Windows): its "old authority"
    // pairs are skipped there with the reason shown; its "old client" pairs still run.
    if (pin.unsupported !== undefined) {
      if (typeof pin.unsupported !== 'object' || pin.unsupported === null) throw new Error(`invalid unsupported map for ${pin.tag}`)
      for (const [platform, reason] of Object.entries(pin.unsupported)) {
        if (!['win32', 'darwin', 'linux'].includes(platform) || typeof reason !== 'string' || !reason.trim()) throw new Error(`invalid unsupported entry for ${pin.tag}: ${platform}`)
      }
    }
  }
  return pins
}
/** Only the single untagged manifest candidate may lack an immutable commit. */
export function validatePinCommit(pin, version, tagCommit) {
  if (!pin.commit) {
    if (pin.tag === `v${version}` && !tagCommit) return
    throw new Error(`${pin.tag} has no recorded commit; run node scripts/compat-pins.mjs ${pin.tag.slice(1)} --pin-commit and commit scripts/compat-pins.json`)
  }
  if (tagCommit && pin.commit !== tagCommit) throw new Error(`${pin.tag} moved: expected ${pin.commit}, got ${tagCommit}`)
}
export function updatePins(pins, version, retire = []) {
  validatePins(pins)
  const tag = `v${version}`
  const [major, minor] = parts(tag)
  const next = pins.some(pin => pin.tag === tag) ? [...pins] : [...pins, { tag }]
  for (const oldTag of retire) {
    if (!next.some(pin => pin.tag === oldTag)) throw new Error(`pin not found: ${oldTag}`)
    const [oldMajor, oldMinor] = parts(oldTag)
    if (oldMajor > major || (oldMajor === major && oldMinor >= minor - 3)) {
      throw new Error(`cannot retire ${oldTag}: inside the three-minor support window of ${tag}`)
    }
  }
  return next.filter(pin => !retire.includes(pin.tag))
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, ...args] = process.argv.slice(2)
  const retire = []
  let pinCommit = false
  while (args.length) {
    const flag = args.shift()
    if (flag === '--pin-commit') { pinCommit = true; continue }
    if (flag !== '--retire' || !args.length) throw new Error('usage: node scripts/compat-pins.mjs VERSION [--retire TAG] [--pin-commit]')
    retire.push(args.shift())
  }
  const file = path.join(root, 'scripts/compat-pins.json')
  const pins = updatePins(JSON.parse(fs.readFileSync(file, 'utf8')), version, retire)
  if (pinCommit) {
    const pin = pins.find(pin => pin.tag === `v${version}`)
    const commit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${pin.tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
    if (pin.commit && pin.commit !== commit) throw new Error(`${pin.tag} moved: expected ${pin.commit}, got ${commit}`)
    pin.commit = commit
  }
  fs.writeFileSync(file, JSON.stringify(pins, null, 2) + '\n')
}
