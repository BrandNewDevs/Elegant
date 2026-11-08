import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { useInViewOnce, useReducedMotion } from '@/lib/motion'
import { DISPLAY_NAME } from '@/site'

/*
 * The brand mark (docs/brand/logo/elegant-mark.svg) is a sound wave that curls into an "e": four half-waves across the
 * middle of a 180 box, then an arc of radius 50 round the centre. It is drawn here as two paths so the wave can move.
 */

const BRAND = '#2F3A8F'

/** The wave's path with each half-wave at its own height; [14, 14, 14, 14] is the logo as drawn. */
function wave(amplitudes: number[]) {
  return amplitudes
    .map((a, i) => {
      const x = 40 + i * 25
      const y = i % 2 === 0 ? 90 - a : 90 + a
      return `${i === 0 ? 'M40 90 ' : ''}Q${x + 12.5} ${y} ${x + 25} 90`
    })
    .join(' ')
}

const RESTING = wave([14, 14, 14, 14])
/** Uneven heights read as a voice rather than a sine. */
const SPEAKING = [
  RESTING,
  wave([6, 19, 10, 5]),
  wave([17, 8, 20, 12]),
  wave([4, 13, 7, 17]),
  wave([12, 20, 9, 8]),
  RESTING,
].join(';')

/**
 * The mark. The wave can speak, moving like a voice for three breaths (under five seconds, so it never needs a pause
 * control): once shortly after load, once when it first scrolls into view, or while `active` (a hover) is true. It stays
 * still for people who prefer reduced motion. `tile` draws the indigo rounded square behind it, as in the app icon.
 */
export function Mark({
  className,
  speak,
  active = false,
  tile = true,
}: {
  className?: string
  speak?: 'load' | 'view'
  active?: boolean
  tile?: boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const animationRef = useRef<SVGAnimateElement>(null)
  const reduced = useReducedMotion()
  const stroke = tile ? '#FFFFFF' : BRAND

  useEffect(() => {
    const animation = animationRef.current
    const svg = svgRef.current
    if (reduced || !animation || !svg) return
    if (speak === 'load') {
      const timer = window.setTimeout(() => animation.beginElement(), 900)
      return () => window.clearTimeout(timer)
    }
    if (speak === 'view') {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            animation.beginElement()
            observer.disconnect()
          }
        },
        { threshold: 1 },
      )
      observer.observe(svg)
      return () => observer.disconnect()
    }
  }, [reduced, speak])

  useEffect(() => {
    if (active && !reduced) animationRef.current?.beginElement()
  }, [active, reduced])

  return (
    <svg ref={svgRef} viewBox="0 0 180 180" aria-hidden className={cn('size-6', className)}>
      {tile && <rect width="180" height="180" rx="41" fill={BRAND} />}
      <g fill="none" stroke={stroke} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round">
        <path d={RESTING}>
          {!reduced && (
            <animate
              ref={animationRef}
              attributeName="d"
              begin="indefinite"
              dur="1.5s"
              repeatCount="3"
              values={SPEAKING}
              calcMode="spline"
              keySplines={Array(5).fill('0.45 0 0.55 1').join(';')}
            />
          )}
        </path>
        <path d="M140 90A50 50 0 1 0 128.3 122.1" />
      </g>
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  const [hovered, setHovered] = useState(false)
  return (
    <span
      className={cn('flex items-center gap-2 font-semibold', className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Mark active={hovered} />
      {DISPLAY_NAME}
    </span>
  )
}

/**
 * The mark stretched into a rule: a long wave that ends curled into the "e". It draws itself the first time it scrolls
 * into view.
 */
export function WaveRule({ className }: { className?: string }) {
  const { ref, state } = useInViewOnce<SVGSVGElement>(0.6)

  // Half the logo's scale: half-waves 12.5 wide and 7 high. As in the logo, the curl (radius 25, round (1035, 30))
  // encloses the last four half-waves.
  const halfWaves = 84
  const d =
    'M10 30 ' +
    Array.from({ length: halfWaves }, (_, i) => {
      const x = 10 + i * 12.5
      return `Q${x + 6.25} ${i % 2 === 0 ? 23 : 37} ${x + 12.5} 30`
    }).join(' ') +
    ' A25 25 0 1 0 1054.15 46.05'

  return (
    <svg
      ref={ref}
      viewBox="0 0 1070 60"
      aria-hidden
      className={cn('h-auto w-full', className)}
      preserveAspectRatio="xMaxYMid meet"
    >
      <path
        d={d}
        pathLength={1}
        fill="none"
        stroke={BRAND}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="1"
        strokeDashoffset={state === 'waiting' ? 1 : 0}
        style={{
          transition: state === 'entering' ? 'stroke-dashoffset 2.4s cubic-bezier(0.65, 0, 0.35, 1)' : 'none',
        }}
      />
    </svg>
  )
}
