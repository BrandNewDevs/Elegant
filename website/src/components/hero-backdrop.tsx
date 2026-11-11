import { useEffect, useRef } from 'react'

import { useReducedMotion } from '@/lib/motion'

/*
 * A field of faint wave lines behind the hero, in the brand indigo. The lines swell around the pointer like a voice on a
 * waveform, and a click or tap sends a ripple through them. A single sweep on load shows that the field responds;
 * after that it only moves while someone interacts, so nothing animates on its own for more than a few seconds, and the
 * loop stops when the field is still. People who prefer reduced motion get one still frame.
 */

const INDIGO = '47, 58, 143'
const LINE_GAP = 30
const STEP = 6
/** One full wave every 60px, near the logo's proportions. */
const K = (2 * Math.PI) / 60
const RESTING_AMPLITUDE = 1.5
const FOCUS_AMPLITUDE = 18
const FOCUS_RADIUS = 120
const INTRO_MS = 4000

type Pulse = { x: number; y: number; start: number }

export function HeroBackdrop({ target }: { target: React.RefObject<HTMLElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    const area = target.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !area || !ctx) return

    let width = 0
    let height = 0
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    // The focus eases towards where the pointer is (or the intro sweep), so the swell glides rather than jumps.
    const focus = { x: 0, y: 0, strength: 0 }
    const pointer = { x: 0, y: 0, inside: false }
    const pulses: Pulse[] = []
    const introStart = performance.now()
    let frame = 0
    let running = false

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height)
      const t = now / 1000
      const glow = ctx.createRadialGradient(focus.x, focus.y, 0, focus.x, focus.y, FOCUS_RADIUS * 2.5)
      glow.addColorStop(0, `rgba(${INDIGO}, ${0.12 + 0.3 * focus.strength})`)
      glow.addColorStop(1, `rgba(${INDIGO}, 0.12)`)
      ctx.strokeStyle = glow
      ctx.lineWidth = 1.25

      for (let line = 0, y0 = LINE_GAP / 2; y0 < height; line++, y0 += LINE_GAP) {
        ctx.beginPath()
        for (let x = 0; x <= width + STEP; x += STEP) {
          const dx = x - focus.x
          const dy = y0 - focus.y
          let amplitude =
            RESTING_AMPLITUDE +
            FOCUS_AMPLITUDE * focus.strength * Math.exp(-(dx * dx + dy * dy) / (2 * FOCUS_RADIUS ** 2))
          for (const pulse of pulses) {
            const age = (now - pulse.start) / 1000
            const distance = Math.hypot(x - pulse.x, y0 - pulse.y)
            const ring = distance - age * 520
            amplitude += 14 * Math.exp(-age / 0.8) * Math.exp(-(ring * ring) / (2 * 40 ** 2))
          }
          const y = y0 + Math.sin(x * K - t * 2.2 + line * 0.7) * amplitude
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }

    const tick = (now: number) => {
      const intro = (now - introStart) / INTRO_MS
      let target = { x: focus.x, y: focus.y, strength: 0 }
      if (pointer.inside) {
        target = { x: pointer.x, y: pointer.y, strength: 1 }
      } else if (intro < 1) {
        target = {
          x: width * (0.1 + 0.8 * intro),
          y: height * (0.5 + 0.18 * Math.sin(intro * Math.PI * 2)),
          strength: Math.sin(intro * Math.PI),
        }
        if (focus.strength === 0) Object.assign(focus, target)
      }
      focus.x += (target.x - focus.x) * 0.12
      focus.y += (target.y - focus.y) * 0.12
      focus.strength += (target.strength - focus.strength) * 0.08

      for (let i = pulses.length - 1; i >= 0; i--) {
        if (now - pulses[i].start > 3000) pulses.splice(i, 1)
      }

      draw(now)

      const settled = !pointer.inside && intro >= 1 && focus.strength < 0.01 && pulses.length === 0
      if (settled) {
        focus.strength = 0
        running = false
      } else {
        frame = requestAnimationFrame(tick)
      }
    }

    const start = () => {
      if (reduced || running || document.hidden) return
      running = true
      frame = requestAnimationFrame(tick)
    }

    const toLocal = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const onMove = (event: PointerEvent) => {
      Object.assign(pointer, toLocal(event), { inside: true })
      start()
    }
    const onLeave = () => {
      pointer.inside = false
    }
    const onDown = (event: PointerEvent) => {
      pulses.push({ ...toLocal(event), start: performance.now() })
      start()
    }
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame)
        running = false
      } else {
        start()
      }
    }

    resize()
    const observer = new ResizeObserver(() => {
      resize()
      if (!running) draw(performance.now())
    })
    observer.observe(canvas)

    if (reduced) {
      draw(0)
      return () => observer.disconnect()
    }

    area.addEventListener('pointermove', onMove)
    area.addEventListener('pointerleave', onLeave)
    area.addEventListener('pointerdown', onDown)
    document.addEventListener('visibilitychange', onVisibility)
    start()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      area.removeEventListener('pointermove', onMove)
      area.removeEventListener('pointerleave', onLeave)
      area.removeEventListener('pointerdown', onDown)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced, target])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 size-full animate-fade [mask-image:linear-gradient(to_bottom,black_75%,transparent)]"
    />
  )
}
