// Where the phone finds this computer on the home network (home-phone.ts). No Electron here, so
// it can be tested on its own.
import { execFileSync } from 'node:child_process'
import { hostname, networkInterfaces } from 'node:os'

// How the phone finds this computer on the Wi-Fi: its address on the home network (192.168.0.12).
// Not the Mac's Bonjour name (eduardos-macbook.local): the iPhone app couldn't reach it by that name
// on a real network, while the address worked. The QR code is made
// when it's shown, so a new address from the router means only a new QR code.
// No home network address (a cable-less, Wi-Fi-less machine): the Bonjour name, then the hostname.
export function homeHost(nets: Parameters<typeof lanAddress>[0] = networkInterfaces()): string {
  const lan = lanAddress(nets)
  if (lan) return lan
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim()
      if (/^[A-Za-z0-9-]{1,63}$/.test(name)) return `${name}.local`.toLowerCase()
    } catch {}
  }
  return hostname()
}

// The address of the Wi-Fi or the cable, not of a virtual network the computer also has (Docker,
// WSL and Hyper-V on Windows, VirtualBox, VMware, a VPN): those come first in some lists, and a
// phone can't reach them. A home router's 192.168.x first, then 10.x, then 172.16–31.x.
export function lanAddress(nets: Record<string, { family: string | number; address: string; internal: boolean }[] | undefined>): string | undefined {
  const virtual = /docker|veth|br-|virbr|vbox|virtualbox|vmware|vmnet|vethernet|hyper-v|wsl|utun|tun|tap|tailscale|zerotier|zt|wg|ppp|llw|awdl|bridge/i
  const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9)
  const found = Object.entries(nets)
    .filter(([name]) => !virtual.test(name))
    .flatMap(([, list]) => (list ?? []).filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal).map((a) => a.address))
    .filter((ip) => rank(ip) < 9)
    .sort((a, b) => rank(a) - rank(b))
  return found[0]
}

