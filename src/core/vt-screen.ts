// A small terminal screen: what a program running in a terminal shows, as lines of text, from the
// bytes it writes (text, carriage returns, cursor moves, erases). Enough for a harness's sign-in
// (its prompts, menus and the page it asks you to open) to be shown on a page or a phone, where
// there's no terminal. Colors and styles are dropped; links (OSC 8) are kept for `links`.

// A row, and whether it goes on from the row above (the text reached the edge and wrapped).
type Row = string[] & { wrapped?: boolean }

export class Screen {
  private rows: Row[]
  private x = 0
  private y = 0
  private saved = { x: 0, y: 0 }
  private pending = '' // an escape sequence cut between two writes
  readonly links: string[] = [] // OSC 8 targets, in order

  constructor(
    readonly cols = 100,
    readonly height = 32
  ) {
    this.rows = Array.from({ length: height }, () => [])
  }

  // The screen as text, a line that wrapped at the edge joined back into one (whoever shows it wraps
  // it to their own width); trailing spaces and empty bottom lines trimmed.
  lines(): string[] {
    const out: string[] = []
    for (const r of this.rows) {
      const text = Array.from(r, (c) => c ?? ' ').join('')
      if (r.wrapped && out.length) out[out.length - 1] += text
      else out.push(text)
    }
    const trimmed = out.map((l) => l.replace(/\s+$/, ''))
    while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop()
    return trimmed
  }

  write(data: string): void {
    const s = this.pending + data
    this.pending = ''
    let i = 0
    while (i < s.length) {
      const c = s[i]!
      if (c === '\x1b') {
        const used = this.escape(s, i)
        if (used === 0) {
          // Not all here yet: the rest comes with the next write (a cut that never ends is dropped).
          this.pending = s.slice(i).slice(0, 4096)
          return
        }
        i += used
        continue
      }
      i += 1
      if (c === '\r') this.x = 0
      else if (c === '\n') this.lineFeed()
      else if (c === '\b') this.x = Math.max(0, this.x - 1)
      else if (c === '\t') this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8)
      else if (c >= ' ' && c !== '\x7f') this.put(c)
      else if (c > '\x9f') this.put(c)
    }
  }

  private put(c: string): void {
    if (this.x >= this.cols) {
      this.x = 0
      this.lineFeed()
      const next: Row = []
      next.wrapped = true
      this.rows[this.y] = next
    }
    const row = this.rows[this.y]!
    while (row.length < this.x) row.push(' ')
    row[this.x] = c
    this.x += 1
  }

  private lineFeed(): void {
    if (this.y < this.height - 1) this.y += 1
    else {
      this.rows.shift()
      this.rows.push([])
    }
  }

  private clamp(): void {
    this.x = Math.max(0, Math.min(this.cols - 1, this.x))
    this.y = Math.max(0, Math.min(this.height - 1, this.y))
  }

  private eraseLine(mode: number): void {
    const row = this.rows[this.y]!
    if (mode === 0) row.length = Math.min(row.length, this.x)
    else if (mode === 1) for (let k = 0; k <= this.x && k < row.length; k++) row[k] = ' '
    else this.rows[this.y] = []
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0)
      for (let k = this.y + 1; k < this.height; k++) this.rows[k] = []
    } else if (mode === 1) {
      for (let k = 0; k < this.y; k++) this.rows[k] = []
      this.eraseLine(1)
    } else this.rows = Array.from({ length: this.height }, () => [])
  }

  // One escape sequence at s[i]: how many characters it took, 0 when it isn't complete yet.
  private escape(s: string, i: number): number {
    const next = s[i + 1]
    if (next === undefined) return 0
    if (next === '[') {
      let j = i + 2
      while (j < s.length && !/[\x40-\x7e]/.test(s[j]!)) j++
      if (j >= s.length) return 0
      this.csi(s.slice(i + 2, j), s[j]!)
      return j - i + 1
    }
    if (next === ']') {
      // OSC, up to BEL or ST (ESC \).
      for (let j = i + 2; j < s.length; j++) {
        if (s[j] === '\x07' || (s[j] === '\x1b' && s[j + 1] === '\\')) {
          const body = s.slice(i + 2, j)
          const link = body.match(/^8;[^;]*;(.+)$/)?.[1]
          if (link && /^https?:\/\//.test(link) && this.links[this.links.length - 1] !== link) this.links.push(link)
          return j - i + (s[j] === '\x07' ? 1 : 2)
        }
      }
      return 0
    }
    if (next === '(' || next === ')' || next === '#') return s[i + 2] === undefined ? 0 : 3 // character sets: nothing to show
    if (next === '7') this.saved = { x: this.x, y: this.y }
    else if (next === '8') ({ x: this.x, y: this.y } = this.saved)
    else if (next === 'M') this.y = Math.max(0, this.y - 1)
    else if (next === 'c') this.eraseDisplay(2)
    return 2
  }

  private csi(params: string, final: string): void {
    const priv = params.startsWith('?')
    const nums = params.replace(/^[?>=]/, '').split(';').map((n) => (n === '' ? NaN : Number(n)))
    const n = (k: number, def: number): number => (Number.isFinite(nums[k]) ? nums[k]! : def)
    if (priv) {
      // The alternate screen (a full-screen program starting or ending): a clean one.
      if ((final === 'h' || final === 'l') && [47, 1047, 1049].includes(n(0, 0))) {
        this.eraseDisplay(2)
        this.x = this.y = 0
      }
      return
    }
    switch (final) {
      case 'A':
        this.y -= n(0, 1) || 1
        break
      case 'B':
      case 'e':
        this.y += n(0, 1) || 1
        break
      case 'C':
      case 'a':
        this.x += n(0, 1) || 1
        break
      case 'D':
        this.x -= n(0, 1) || 1
        break
      case 'E':
        this.y += n(0, 1) || 1
        this.x = 0
        break
      case 'F':
        this.y -= n(0, 1) || 1
        this.x = 0
        break
      case 'G':
      case '`':
        this.x = n(0, 1) - 1
        break
      case 'd':
        this.y = n(0, 1) - 1
        break
      case 'H':
      case 'f':
        this.y = n(0, 1) - 1
        this.x = n(1, 1) - 1
        break
      case 'J':
        this.eraseDisplay(n(0, 0))
        break
      case 'K':
        this.eraseLine(n(0, 0))
        break
      case 'X': {
        const row = this.rows[this.y]!
        for (let k = this.x; k < this.x + (n(0, 1) || 1) && k < row.length; k++) row[k] = ' '
        break
      }
      case 'P': {
        this.rows[this.y]!.splice(this.x, n(0, 1) || 1)
        break
      }
      case '@': {
        const row = this.rows[this.y]!
        while (row.length < this.x) row.push(' ')
        row.splice(this.x, 0, ...Array<string>(n(0, 1) || 1).fill(' '))
        if (row.length > this.cols) row.length = this.cols
        break
      }
      case 'L': {
        const k = Math.min(n(0, 1) || 1, this.height - this.y)
        this.rows.splice(this.y, 0, ...Array.from({ length: k }, () => []))
        this.rows.length = this.height
        break
      }
      case 'M': {
        const k = Math.min(n(0, 1) || 1, this.height - this.y)
        this.rows.splice(this.y, k)
        while (this.rows.length < this.height) this.rows.push([])
        break
      }
      case 's':
        this.saved = { x: this.x, y: this.y }
        break
      case 'u':
        ;({ x: this.x, y: this.y } = this.saved)
        break
      default:
      // m (colors), r (scroll region), h/l (modes), n (reports): nothing to show
    }
    this.clamp()
  }
}

// The sign-in page and a code to type there, as shown on the screen. A link the program marked
// (OSC 8) wins; else the last https address in the text (a wrapped one is whole in lines()).
export function signInHints(screen: Screen): { url?: string; code?: string } {
  const lines = screen.lines()
  let url = screen.links[screen.links.length - 1]
  if (!url) {
    const all = lines.join('\n').match(/https:\/\/[^\s"'<>]+/g)
    url = all?.[all.length - 1]?.replace(/[).,;:]+$/, '')
  }
  // A device code: groups of capitals and digits with a dash (ABCD-EFGH, 1A2B-3C4D5).
  const code = lines
    .join('\n')
    .match(/(?:^|[^A-Za-z0-9-])([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?![A-Za-z0-9-])/)?.[1]
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) }
}
