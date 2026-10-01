// What a test process inherits must not change what it tests. A suite run inside a Claude or Codex session, inside a
// Room worker, or from a git hook would otherwise act as that session or worker, read the user's installed plugins,
// operate on the hook's repository, or reach a real server database.
import path from 'node:path'

// `git rev-parse --local-env-vars`: each points git at a repository other than the one a test creates.
const GIT_LOCATION = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR']
// Set by room_spawn for a worker's own commands; read again by the worker code under test.
const WORKER_LAUNCH = ['PORT', 'VIRTUAL_ENV', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS',
  'NUMEXPR_NUM_THREADS', 'LOKY_MAX_CPU_COUNT', 'RAYON_NUM_THREADS']
// Server configuration: a developer's shell may point these at a real deployment.
const SERVER = ['DATABASE_URL', 'YPERSISTENCE', 'PUBLIC_URL', 'GITHUB_CLIENT_ID', 'HOST']
const INHERITED = new Set([...GIT_LOCATION, ...WORKER_LAUNCH, ...SERVER, 'CLAUDECODE'])
const INHERITED_PREFIXES = ['ROOM_', 'CLAUDE_', 'CODEX_', 'OIDC_']

/** Remove inherited host, Room, git and server state from `env`, and point every config dir under `configHome`. */
export function isolateTestEnv(env: NodeJS.ProcessEnv, configHome: string): void {
  for (const key of Object.keys(env)) if (INHERITED.has(key) || INHERITED_PREFIXES.some(p => key.startsWith(p))) delete env[key]
  // Tests never write the user's Room config dir (machine-id, credentials, worker port reservations), nor read
  // the user's Codex rollouts and plugin cache, or Claude Code's installed-plugin list.
  env.XDG_CONFIG_HOME = configHome
  env.CODEX_HOME = path.join(configHome, 'codex')
  env.CLAUDE_CONFIG_DIR = path.join(configHome, 'claude')
}
