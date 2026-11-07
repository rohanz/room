export const missingWorkspace = 'Room could not tell which folder this Codex session is in (no workspace in the call). Update Codex, or start it with ROOM_DIR=<repo>.'
export const workspaceMismatch = (workspace: string, bound: string) => `This Codex session's workspace is ${workspace}, but Room is attached to ${bound}; restart the session to switch.`
