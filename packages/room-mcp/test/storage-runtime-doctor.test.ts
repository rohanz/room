import { expect, it } from 'vitest'
import { evaluateDoctor, type DoctorFacts } from '../src/doctor.js'
import type { PreflightResult } from '@room/local-state/protocol'
const facts: DoctorFacts = { node: '22.23.4', repo: true, git: '2.40.0', claudeCli: false, codexCli: false }
const preflight: PreflightResult = { ok: true, storage: 'unqualified', evidence: { surface: 'mcp', executable: '/qualified/node', node: '22.23.4', sqlite: '3.51.3', elapsedMs: 1, vendor: { name: 'node', platform: 'linux', arch: 'x64' } } }
it.each(['22.12.0', '22.14.0', '24.0.0'])('refuses an unqualified Node %s in doctor', node => {
  expect(evaluateDoctor({ ...facts, node }).find(row => row.name === 'Node')?.level).toBe('FAIL')
})
it('reports daemon evidence independently and preserves missing-evidence legacy adoption', () => {
  const rows = evaluateDoctor({ ...facts, preflight, daemonPresent: true })
  expect(rows.find(row => row.name === 'daemon runtime')).toMatchObject({ level: 'WARN', finding: expect.stringContaining('evidence unavailable') })
  const different = { ...preflight, evidence: { ...preflight.evidence, surface: 'daemon' as const, executable: '/daemon/node' } }
  expect(evaluateDoctor({ ...facts, preflight, daemonPreflight: different }).find(row => row.name === 'daemon runtime')?.finding).toContain('different executable from MCP')
})
