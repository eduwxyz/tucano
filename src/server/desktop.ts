/** Server desktop access is opt-in and only ever targets this Linux server's session. */
export type ServerDesktopState = { enabled: boolean; ready: boolean; reason?: 'disabled' | 'platform' | 'display' | 'dbus' | 'helper'; suggestion?: string }
export function serverDesktopState(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, helper: boolean): ServerDesktopState {
  if (env['TUCANO_SERVER_DESKTOP'] !== '1') return { enabled: false, ready: false, reason: 'disabled', suggestion: 'Enable the VPS desktop explicitly with the installer --desktop option. The headless browser and Docker computers remain available.' }
  if (platform !== 'linux') return { enabled: true, ready: false, reason: 'platform', suggestion: 'The server desktop requires Linux. It cannot control apps on the connected Mac.' }
  if (!/^:\d+(?:\.\d+)?$/.test(env['DISPLAY'] ?? '')) return { enabled: true, ready: false, reason: 'display', suggestion: 'Start this service through scripts/server-desktop.sh to create a private local Xvfb display.' }
  if (!/^unix:/.test(env['DBUS_SESSION_BUS_ADDRESS'] ?? '')) return { enabled: true, ready: false, reason: 'dbus', suggestion: 'Start this service through scripts/server-desktop.sh with dbus-run-session and Linux AT-SPI installed.' }
  if (!helper) return { enabled: true, ready: false, reason: 'helper', suggestion: 'Install agent-desktop@1.0.2 for the VPS service user, make it available on PATH, then restart the service.' }
  return { enabled: true, ready: true }
}
