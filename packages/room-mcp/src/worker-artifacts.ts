/** Shared secure artifact writes. Host plans supply content and interpret write outcomes. */
import fs from 'node:fs'
import path from 'node:path'
import type { WorkerArtifactOutcome, WorkerPlan } from './hosts/types.js'

export function writeWorkerArtifacts(logDir: string, plan: Pick<WorkerPlan, 'artifacts' | 'artifactEnv' | 'envPatch'>): {
  outcomes: WorkerArtifactOutcome[]; envPatch: Record<string, string>
} {
  const directory = path.resolve(logDir, '.room', 'workers')
  const artifacts = new Map<string, WorkerPlan['artifacts'][number]>()
  const paths = new Set<string>()
  // Validate the complete plan before writing any of it. Artifacts remain direct children
  // beside the logs; a host cannot redirect a write or make conditional env unconditional.
  for (const artifact of plan.artifacts) {
    const file = path.resolve(artifact.path)
    if (!artifact.id || artifacts.has(artifact.id) || paths.has(file)
      || path.dirname(file) !== directory || !Number.isInteger(artifact.mode)
      || artifact.mode < 0 || artifact.mode > 0o777) throw new Error('invalid worker artifact plan')
    artifacts.set(artifact.id, artifact)
    paths.add(file)
  }
  for (const entry of plan.artifactEnv) {
    if (!artifacts.has(entry.artifactId) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key)
      || Object.hasOwn(plan.envPatch, entry.key)) throw new Error('invalid worker artifact environment')
  }
  if (Object.values(plan.envPatch).some(value => paths.has(path.resolve(value)))) throw new Error('unconditional worker artifact environment')
  const outcomes: WorkerArtifactOutcome[] = []
  const envPatch = { ...plan.envPatch }
  for (const artifact of artifacts.values()) {
    try {
      // `wx` guards only the last component: reject linked parent directories too.
      for (const dir of [path.join(logDir, '.room'), directory]) {
        try { fs.mkdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
        if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`)
      }
      fs.rmSync(artifact.path, { force: true })
      fs.writeFileSync(artifact.path, artifact.content, { mode: artifact.mode, flag: 'wx' })
      outcomes.push({ artifactId: artifact.id, path: artifact.path, written: true })
      for (const entry of plan.artifactEnv) if (entry.artifactId === artifact.id) envPatch[entry.key] = artifact.path
    } catch (e) {
      outcomes.push({ artifactId: artifact.id, path: artifact.path, written: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { outcomes, envPatch }
}
