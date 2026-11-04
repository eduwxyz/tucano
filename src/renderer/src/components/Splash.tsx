// The opening of the introduction: the forest of the launch video, in short. The
// toucan of the icon on a branch; a helicopter brings the team down on ropes; the
// toucan flies at you and its wing closes the screen on the drop of the music; the
// name. One GSAP timeline, SVG drawn here, one sound file mixed to the same times.
// A click or any key skips it; with "Reduzir movimento" on, it doesn't play.
import { L } from '../../../shared/lang'
import { gsap } from 'gsap'
import { useEffect, useRef, type ReactNode } from 'react'
import sound from '../assets/splash.mp3'

const C = {
  black: '#111111', orange: '#FF8A1F', deep: '#E2541B', white: '#FFFFFF', feet: '#7C8CA3',
  far: '#C4D3B4', mid: '#8DAE88', near: '#4F7D5C', dark: '#1F5A43', mata: '#0F3D30', deepest: '#0A2C22', bark: '#3A2A22', barkDark: '#2A1E18'
}
const BOTS = [
  { color: '#8b5cf6', rope: 0, land: 790 },
  { color: '#14a3a3', rope: 1, land: 1460 },
  { color: '#3b9eea', rope: 0, land: 1000 },
  { color: '#e3a008', rope: 1, land: 1200 }
]
const BRANCH_Y = 766
const LAND = BRANCH_Y + 2
const ROPES = [1000, 1200]
const HOVER = { x: 1100, y: 196 }
const DROP = 5.6 // the wing closes the screen here; the mixed sound has its drop here too
const END = 8.0

// ---------- the drawing ----------
const circles = (list: number[][], fill: string): string => list.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`).join('')
// A row of round treetops from x0 to x1, standing on y, with a solid band below.
function canopy(x0: number, x1: number, y: number, rMin: number, rMax: number, step: number, fill: string, seed: number): string {
  let s = seed
  const rnd = (): number => (s = (s * 9301 + 49297) % 233280) / 233280
  const list: number[][] = []
  for (let x = x0; x < x1; x += step * (0.7 + rnd() * 0.6)) list.push([x, y - rnd() * 40, rMin + rnd() * (rMax - rMin)])
  return `${circles(list, fill)}<rect x="${x0 - 200}" y="${y}" width="${x1 - x0 + 400}" height="${1400 - y}" fill="${fill}"/>`
}
const leaf = (x: number, y: number, r: number, rot: number, fill: string): string => `<path d="M0 0 H${r} A${r} ${r} 0 0 0 0 ${-r} Z" fill="${fill}" transform="translate(${x} ${y}) rotate(${rot})"/>`
const wing = (fill: string): string => `<path d="M0 0 C 50 -150, -40 -320, -190 -420 C -170 -270, -150 -140, -80 10 Z" fill="${fill}"/>`

const TOUCAN = `
  <g class="sp-tc" transform="translate(470 ${BRANCH_Y}) scale(.62)">
    <defs>
      <clipPath id="sp-tc-shape"><ellipse cx="0" cy="-200" rx="130" ry="160"/><circle cx="40" cy="-360" r="110"/></clipPath>
      <clipPath id="sp-tc-beak"><path d="M120 -350 V-450 A230 100 0 0 1 350 -350 Z"/></clipPath>
    </defs>
    <path d="M-60 -150 L0 -110 L-70 70 L-140 48 Z" fill="${C.black}"/>
    <rect x="-28" y="-60" width="18" height="62" rx="9" fill="${C.feet}"/>
    <rect x="22" y="-60" width="18" height="62" rx="9" fill="${C.feet}"/>
    <ellipse cx="0" cy="-200" rx="130" ry="160" fill="${C.black}"/>
    <ellipse cx="96" cy="-262" rx="62" ry="86" fill="${C.white}" clip-path="url(#sp-tc-shape)"/>
    <g class="sp-head">
      <circle cx="40" cy="-360" r="110" fill="${C.black}"/>
      <path d="M120 -310 V-350 H335 A215 40 0 0 1 120 -310 Z" fill="${C.deep}"/>
      <path d="M120 -350 V-450 A230 100 0 0 1 350 -350 Z" fill="${C.orange}"/>
      <circle cx="352" cy="-350" r="62" fill="${C.black}" clip-path="url(#sp-tc-beak)"/>
      <g class="sp-eye"><circle cx="66" cy="-384" r="40" fill="${C.white}"/><circle class="sp-pupil" cx="78" cy="-384" r="17" fill="${C.black}"/></g>
    </g>
  </g>`

const HELI = `
  <g class="sp-heli-pos"><g class="sp-heli">
    <rect x="110" y="-24" width="230" height="26" rx="13" fill="#1E2A38"/>
    <path d="M318 -24 L352 -88 L372 -88 L356 -10 Z" fill="${C.orange}"/>
    <g class="sp-tail" transform="translate(352 -22)"><rect x="-6" y="-38" width="12" height="76" rx="6" fill="#2B3A4C"/></g>
    <rect x="-20" y="-112" width="16" height="34" fill="#2B3A4C"/>
    <path d="M-150 0 A150 90 0 0 1 150 -10 L150 40 A40 40 0 0 1 110 80 L-90 80 A60 80 0 0 1 -150 0 Z" fill="#1E2A38"/>
    <path d="M-150 0 A150 90 0 0 1 -40 -84 L-40 0 Z" fill="#BFE0E6"/>
    <rect x="-150" y="14" width="300" height="14" fill="${C.orange}"/>
    <rect x="-30" y="0" width="100" height="74" rx="8" fill="#0E151F"/>
    <rect x="-110" y="96" width="250" height="10" rx="5" fill="#2B3A4C"/>
    <rect x="-70" y="74" width="10" height="26" fill="#2B3A4C"/><rect x="90" y="74" width="10" height="26" fill="#2B3A4C"/>
    <g class="sp-rotor" transform="translate(-12 -114)"><rect x="-300" y="-6" width="600" height="12" rx="6" fill="#2B3A4C"/></g>
  </g></g>`

const FLYER = `
  <g class="sp-fly-pos"><g class="sp-fly">
    <g class="sp-wing-back" transform="translate(10 -70)">${wing('#2A2A2A')}</g>
    <path d="M-100 30 L-70 90 L-330 150 L-340 80 Z" fill="${C.black}"/>
    <ellipse cx="0" cy="0" rx="130" ry="160" fill="${C.black}"/>
    <ellipse cx="96" cy="-62" rx="62" ry="86" fill="${C.white}" clip-path="url(#sp-fly-shape)"/>
    <circle cx="40" cy="-160" r="110" fill="${C.black}"/>
    <path d="M120 -110 V-150 H335 A215 40 0 0 1 120 -110 Z" fill="${C.deep}"/>
    <path d="M120 -150 V-250 A230 100 0 0 1 350 -150 Z" fill="${C.orange}"/>
    <circle cx="352" cy="-150" r="62" fill="${C.black}" clip-path="url(#sp-fly-beak)"/>
    <circle cx="66" cy="-184" r="40" fill="${C.white}"/><circle cx="74" cy="-180" r="17" fill="${C.black}"/>
    <g class="sp-wing-front" transform="translate(-20 -60)">${wing(C.black)}</g>
  </g></g>`

const bot = (b: (typeof BOTS)[number], i: number): string => `
  <g class="sp-bot sp-bot-${i}"><g class="sp-squash"><g transform="scale(1.2)">
    <rect x="-50" y="-100" width="100" height="100" rx="28" fill="${b.color}"/>
    <rect x="-50" y="-34" width="100" height="10" fill="${C.black}" opacity=".85"/>
    <rect class="sp-e" x="-27" y="-74" width="16" height="22" rx="7" fill="#fff"/><rect class="sp-e" x="11" y="-74" width="16" height="22" rx="7" fill="#fff"/>
    <g class="sp-hands" fill="none" stroke="${b.color}" stroke-width="9" stroke-linecap="round">
      <path d="M-36 -92 L-7 -116"/><path d="M36 -92 L7 -132"/>
      <circle cx="-5" cy="-118" r="8" fill="${b.color}" stroke="none"/><circle cx="5" cy="-134" r="8" fill="${b.color}" stroke="none"/>
    </g>
  </g></g></g>`

const SCENE = `
  <svg class="sp-world" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sp-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6F0E4"/><stop offset=".7" stop-color="#F8DDB8"/><stop offset="1" stop-color="#F6C998"/></linearGradient>
      <clipPath id="sp-fly-shape"><ellipse cx="0" cy="0" rx="130" ry="160"/><circle cx="40" cy="-160" r="110"/></clipPath>
      <clipPath id="sp-fly-beak"><path d="M120 -150 V-250 A230 100 0 0 1 350 -150 Z"/></clipPath>
    </defs>
    <g class="sp-cam">
      <rect x="-400" y="-400" width="2720" height="1880" fill="url(#sp-sky)"/>
      <g class="sp-sun"><circle cx="1480" cy="430" r="240" fill="#FFC27A" opacity=".35"/><circle cx="1480" cy="430" r="150" fill="#FFB25C"/></g>
      <g class="sp-far">${canopy(-300, 2300, 690, 90, 160, 170, C.far, 7)}</g>
      <g class="sp-mid">${canopy(-300, 2300, 800, 110, 190, 210, C.mid, 31)}<rect x="1700" y="560" width="26" height="300" fill="#6F946F"/><rect x="300" y="600" width="22" height="260" fill="#6F946F"/></g>
      ${HELI}
      <g class="sp-ropes">${ROPES.map((x) => `<rect class="sp-rope" x="${x - 3}" y="270" width="6" height="${BRANCH_Y - 310}" rx="3" fill="#3A3226"/>`).join('')}</g>
      <g class="sp-near">${canopy(-300, 2300, 960, 130, 210, 260, C.near, 113)}</g>
      <g>
        <path d="M40 1200 L60 -100 L270 -100 L250 1200 Z" fill="${C.bark}"/>
        <path d="M200 1200 L215 -100 L270 -100 L250 1200 Z" fill="${C.barkDark}"/>
        <path d="M220 760 Q 900 744 1600 772 L1600 800 Q 900 790 230 812 Z" fill="${C.bark}"/>
        <path d="M230 796 Q 900 784 1600 790 L1600 800 Q 900 792 230 812 Z" fill="${C.barkDark}"/>
        <path d="M1300 772 Q 1420 700 1500 620 L1514 628 Q 1440 712 1330 786 Z" fill="${C.bark}"/>
        ${circles([[120, -40, 260], [380, 40, 200], [620, -20, 190], [-60, 220, 200]], C.mata)}${circles([[260, 120, 120], [520, 100, 110]], C.dark)}
        <g class="sp-sway" transform="translate(1500 620)">${leaf(0, 0, 90, -30, C.dark)}${leaf(0, 0, 70, -120, C.mata)}${leaf(0, 0, 60, 50, C.dark)}</g>
        <g class="sp-sway" transform="translate(1600 786)">${leaf(0, 0, 80, 10, C.mata)}${leaf(0, 0, 70, 100, C.dark)}${leaf(0, 0, 54, -60, C.dark)}</g>
        <g class="sp-sway" transform="translate(700 -20)"><rect x="-3" y="0" width="6" height="380" fill="${C.mata}"/>${leaf(0, 380, 46, 60, C.dark)}${leaf(0, 250, 36, -150, C.mata)}${leaf(0, 140, 30, 40, C.dark)}</g>
      </g>
      <g>${BOTS.map(bot).join('')}</g>
      ${TOUCAN}
      <g class="sp-front">
        <g class="sp-sway" transform="translate(-40 1110)">${leaf(0, 0, 260, -70, C.deepest)}${leaf(0, 0, 220, -10, C.mata)}</g>
        <g class="sp-sway" transform="translate(1960 1120)">${leaf(0, 0, 300, -160, C.deepest)}${leaf(0, 0, 240, -110, C.mata)}</g>
      </g>
      ${FLYER}
    </g>
  </svg>
  <svg class="sp-curtain" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice"><g transform="translate(2120 120)"><g class="sp-lens-wing"><g transform="scale(10)">${wing(C.black)}</g></g></g></svg>`

const ICON = `<svg viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="sp-icon"><rect width="100" height="100" rx="26"/></clipPath></defs><g clip-path="url(#sp-icon)">
  <rect width="100" height="100" fill="#F1ECE2"/><circle cx="27" cy="73" r="48" fill="#121212"/><circle cx="38" cy="47" r="14" fill="#fff"/><circle cx="43" cy="47" r="5.5" fill="#121212"/>
  <path d="M53 24 Q84 25 93 44 L96 57 L53 57 Z" fill="#FF8C24"/><path d="M53 57 L95 57 Q86 70 53 71 Z" fill="#E5531F"/><path d="M83 57 A9 12 0 0 1 97 47 L97 57 Z" fill="#121212"/></g></svg>`

export function Splash({ onDone }: { onDone: () => void }): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const skipRef = useRef<() => void>(onDone)

  useEffect(() => {
    const el = root.current
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone()
      return
    }
    const $ = (q: string): Element => el.querySelector(q)!
    const $$ = (q: string): Element[] => [...el.querySelectorAll(q)]
    const origin = (e: Element | string, x: number, y: number): void => void gsap.set(e, { svgOrigin: `${x} ${y}` })
    const tl = gsap.timeline({ onComplete: onDone })
    const audio = new Audio(sound)
    audio.volume = 0.8
    void audio.play().catch(() => {})

    // The camera starts close on the toucan, then opens to the forest.
    const cam = $('.sp-cam')
    gsap.set(cam, { transformOrigin: '0 0', scale: 1.32, x: 0, y: -240 })
    tl.to(cam, { scale: 1, y: 0, duration: 1.3, ease: 'power3.inOut' }, 0.5)
    tl.fromTo('.sp-far', { x: 0 }, { x: -14, duration: END, ease: 'none' }, 0)
    tl.fromTo('.sp-near', { x: 0 }, { x: -40, duration: END, ease: 'none' }, 0)
    tl.fromTo('.sp-front', { x: 0 }, { x: -80, duration: END, ease: 'none' }, 0)
    tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.35, ease: 'none' }, 0)

    // The toucan: breathing, blinking, looking, the nod.
    const head = $('.sp-head')
    origin(head, 40, -290)
    origin('.sp-eye', 66, -384)
    origin('.sp-tc', 470, BRANCH_Y)
    tl.fromTo('.sp-tc', { scaleY: 0.62 }, { scaleY: 0.632, duration: 1.1, ease: 'sine.inOut', yoyo: true, repeat: 3 }, 0)
    const blink = (t: number): void => {
      tl.to('.sp-eye', { scaleY: 0.1, duration: 0.07, ease: 'power2.in' }, t)
      tl.to('.sp-eye', { scaleY: 1, duration: 0.1, ease: 'power2.out' }, t + 0.07)
    }
    blink(0.4)
    tl.to(head, { rotation: -14, duration: 0.3, ease: 'back.out(2)' }, 0.85) // hears it: up to the sky
    tl.to(head, { rotation: 8, duration: 0.3, ease: 'back.out(2)' }, 2.2) // follows the ropes down
    blink(2.9)
    tl.to(head, { rotation: 12, duration: 0.16, ease: 'power2.in' }, 3.6) // the nod
    tl.to(head, { rotation: 0, duration: 0.28, ease: 'back.out(3)' }, 3.76)
    blink(4.05)

    // The helicopter: in, hovering, out.
    const hp = $('.sp-heli-pos')
    gsap.set(hp, { x: 2350, y: -40 })
    origin('.sp-heli', 0, 0)
    gsap.set('.sp-heli', { rotation: -9 })
    tl.to(hp, { x: HOVER.x, y: HOVER.y, duration: 1.4, ease: 'power2.out' }, 0.6)
    tl.to('.sp-heli', { rotation: 2, duration: 0.6, ease: 'power2.out' }, 1.6)
    tl.to(hp, { y: HOVER.y + 8, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 3 }, 2.0)
    tl.to('.sp-heli', { rotation: -12, duration: 0.5, ease: 'power2.in' }, 3.75)
    tl.to(hp, { x: -600, y: -180, duration: 1.0, ease: 'power2.in' }, 3.8)
    origin('.sp-rotor', -12, -114)
    tl.fromTo('.sp-rotor', { scaleX: 1 }, { scaleX: 0.08, duration: 0.05, ease: 'none', yoyo: true, repeat: 99 }, 0)
    tl.fromTo('.sp-tail', { rotation: 0 }, { rotation: 360 * 20, duration: END, ease: 'none', svgOrigin: '352 -22' }, 0)

    // Wind under the blades: the leaves shake.
    $$('.sp-sway').forEach((g, i) => {
      // Kept in a data attribute: GSAP rewrites the transform, and StrictMode runs this twice in dev.
      const at = ((g as SVGElement).dataset['at'] ??= g.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!.slice(1).join(' '))
      const [x, y] = at.split(' ').map(Number)
      origin(g, x!, y!)
      tl.to(g, { rotation: -6 - (i % 3) * 2, duration: 0.18, ease: 'sine.inOut', yoyo: true, repeat: 11 }, 1.8 + i * 0.03)
      tl.to(g, { rotation: 0, duration: 0.6, ease: 'sine.out' }, 4.2)
    })

    // The ropes, and the team down them: a squash on the branch, a hop to their place.
    $$('.sp-rope').forEach((r, i) => {
      origin(r, ROPES[i]!, 270)
      gsap.set(r, { scaleY: 0 })
      tl.to(r, { scaleY: 1, duration: 0.3, ease: 'power3.out' }, 2.0 + i * 0.06)
      tl.to(r, { scaleY: 0, duration: 0.3, ease: 'power2.in' }, 3.65 + i * 0.05)
    })
    BOTS.forEach((b, i) => {
      const g = $(`.sp-bot-${i}`)
      const sq = g.querySelector('.sp-squash')!
      const hands = g.querySelector('.sp-hands')!
      const t0 = i < 2 ? 2.25 + i * 0.12 : 2.85 + (i - 2) * 0.12
      gsap.set(g, { x: ROPES[b.rope], y: 260, autoAlpha: 0 })
      origin(sq, 0, 0)
      tl.set(g, { autoAlpha: 1 }, t0)
      tl.fromTo(g, { y: HOVER.y + 245 }, { y: LAND - 30, duration: 0.48, ease: 'power2.in', immediateRender: false }, t0)
      tl.to(g, { y: LAND, duration: 0.12, ease: 'power1.out' }, t0 + 0.48)
      tl.to(sq, { scaleY: 0.78, scaleX: 1.16, duration: 0.07, ease: 'power2.out' }, t0 + 0.6)
      tl.to(sq, { scaleY: 1, scaleX: 1, duration: 0.36, ease: 'elastic.out(1.1, 0.45)' }, t0 + 0.67)
      tl.to(hands, { y: 60, autoAlpha: 0, duration: 0.18, ease: 'power2.in' }, t0 + 0.62)
      if (b.land !== ROPES[b.rope]) {
        const th = t0 + 0.8
        tl.to(g, { x: b.land, duration: 0.36, ease: 'power1.inOut' }, th)
        tl.to(g, { y: LAND - 80, duration: 0.18, ease: 'power2.out' }, th)
        tl.to(g, { y: LAND, duration: 0.18, ease: 'power2.in' }, th + 0.18)
      }
      // They look at the toucan, then at you.
      const eyes = g.querySelectorAll('.sp-e')
      tl.to(eyes, { x: -5, duration: 0.2 }, 3.6)
      tl.to(eyes, { x: -3, y: -7, duration: 0.18 }, 4.0 + i * 0.04)
      tl.to(sq, { scaleY: 1.08, scaleX: 0.95, duration: 0.12, ease: 'power2.out', yoyo: true, repeat: 1 }, 4.1 + i * 0.05)
    })

    // The flight: a crouch, the jump, and straight at you, faster and faster.
    const TAKEOFF = 4.45
    tl.to('.sp-tc', { scaleY: 0.54, scaleX: 0.66, duration: 0.15, ease: 'power2.out' }, 4.3)
    tl.set('.sp-tc', { autoAlpha: 0 }, TAKEOFF)
    const pos = $('.sp-fly-pos')
    const fly = $('.sp-fly')
    origin(fly, 0, 0)
    gsap.set(pos, { x: 470, y: BRANCH_Y - 200 * 0.62, autoAlpha: 0 })
    gsap.set(fly, { scale: 0.62 })
    tl.set(pos, { autoAlpha: 1 }, TAKEOFF)
    tl.to(pos, { x: 450, y: 450, duration: 0.35, ease: 'power2.out' }, TAKEOFF)
    tl.to(fly, { scale: 0.8, rotation: -22, duration: 0.35, ease: 'power2.out' }, TAKEOFF)
    tl.to(pos, { x: 900, y: 700, duration: DROP - TAKEOFF - 0.35, ease: 'power2.in' }, TAKEOFF + 0.35)
    tl.to(fly, { scale: 9, rotation: 4, duration: DROP - TAKEOFF - 0.35, ease: 'expo.in' }, TAKEOFF + 0.35)
    origin('.sp-wing-front', -20, -60)
    origin('.sp-wing-back', 10, -70)
    tl.fromTo('.sp-wing-front', { rotation: 10 }, { rotation: -125, duration: 0.1, ease: 'sine.inOut', yoyo: true, repeat: 10, immediateRender: false }, TAKEOFF)
    tl.fromTo('.sp-wing-back', { rotation: 25 }, { rotation: -95, duration: 0.1, ease: 'sine.inOut', yoyo: true, repeat: 10, immediateRender: false }, TAKEOFF + 0.025)
    // The near wing, right at you: it sweeps in and closes the screen.
    const lw = $('.sp-lens-wing')
    origin(lw, 0, 0)
    gsap.set(lw, { rotation: 60 })
    tl.to(lw, { rotation: -100, duration: 0.17, ease: 'power1.in' }, DROP - 0.18)

    // Black, the drop, and the name.
    tl.to('.sp-black', { autoAlpha: 1, duration: 0.04, ease: 'none' }, DROP - 0.04)
    tl.set('.sp-world', { autoAlpha: 0 }, DROP)
    tl.fromTo('.sp-logo', { autoAlpha: 0, scale: 0.3, rotation: -14 }, { autoAlpha: 1, scale: 1, rotation: 0, duration: 0.55, ease: 'back.out(2)', immediateRender: false }, DROP + 0.3)
    tl.fromTo('.sp-name', { autoAlpha: 0, x: -40 }, { autoAlpha: 1, x: 0, duration: 0.55, ease: 'expo.out', immediateRender: false }, DROP + 0.55)
    tl.fromTo('.sp-line', { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power2.out', immediateRender: false }, DROP + 0.95)
    tl.to(el, { autoAlpha: 0, duration: 0.45, ease: 'power1.in' }, END - 0.45)

    // While it sits on the branch, the toucan's eye follows your pointer.
    const pupil = $('.sp-pupil')
    const eye = el.querySelector('.sp-eye circle')!
    const follow = (e: PointerEvent): void => {
      if (tl.time() > TAKEOFF) return
      const r = eye.getBoundingClientRect()
      const a = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2))
      gsap.to(pupil, { attr: { cx: 66 + Math.cos(a) * 18, cy: -384 + Math.sin(a) * 18 }, duration: 0.2, overwrite: true })
    }
    // Skipping fades out (and the sound with it) instead of cutting: the same exit as the end, faster.
    let skipping = false
    const skip = (): void => {
      if (skipping) return
      skipping = true
      tl.pause()
      gsap.to(audio, { volume: 0, duration: 0.25 })
      gsap.to(el, { autoAlpha: 0, duration: 0.25, ease: 'power1.in', onComplete: onDone })
    }
    skipRef.current = skip
    window.addEventListener('pointermove', follow)
    window.addEventListener('keydown', skip)
    return () => {
      tl.kill()
      gsap.killTweensOf([el, audio])
      audio.pause()
      window.removeEventListener('pointermove', follow)
      window.removeEventListener('keydown', skip)
    }
  }, [onDone])

  return (
    <div className="splash" ref={root} onClick={() => skipRef.current()}>
      <div className="splash__scene" dangerouslySetInnerHTML={{ __html: SCENE }} />
      <div className="sp-black">
        <div className="sp-mark">
          <span className="sp-logo" dangerouslySetInnerHTML={{ __html: ICON }} />
          <h1 className="sp-name">Tucano</h1>
          <p className="sp-line">{L('Seu time de agentes de IA.', 'Your team of AI agents.')}</p>
        </div>
      </div>
      <div className="splash__drag" />
      <span className="splash__skip">{L('clique ou aperte uma tecla pra pular', 'click or press any key to skip')}</span>
    </div>
  )
}
