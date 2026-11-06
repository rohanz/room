import { gitCommonDir } from '@room/roomd'
import { legacyStatus } from './offline/room-state.js'

/** Read-only diagnostics, including pre-registry evidence; never registers or initializes storage. */
export async function storageDoctorRows(dir: string): Promise<string[]> {
  try {
    const status = await legacyStatus(await gitCommonDir(dir))
    const gate = status.gate
    return [
      `${status.refusal ? 'FAIL' : 'INFO'}  storage gate: ${gate?.phase ?? status.state}; generation ${gate?.generation ?? 0}; registrations ${status.registrations}; tickets ${status.tickets}`,
      `${status.maintenanceRequired ? 'FAIL' : 'PASS'}  storage maintenance: ${status.maintenanceRequired ? 'required' : 'not required'}; legacy import ${status.legacyImport}${status.remedy ? `\n      fix: ${status.remedy}` : ''}`,
    ]
  } catch { return ['FAIL  storage gate: unavailable; run node <plugin>/server/room-state.mjs status --common-dir <dir>'] }
}
