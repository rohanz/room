/** Show first-connect failures immediately, but suppress brief reconnect blips. */
export function reconnectStatus(banner: Pick<HTMLElement, 'hidden'>): (connected: boolean) => void {
  let everConnected = false
  let pending: ReturnType<typeof setTimeout> | undefined
  return connected => {
    if (connected) {
      everConnected = true
      clearTimeout(pending)
      pending = undefined
      banner.hidden = true
    } else if (!everConnected) {
      banner.hidden = false
    } else if (banner.hidden && pending === undefined) {
      pending = setTimeout(() => { banner.hidden = false; pending = undefined }, 2000)
    }
  }
}
