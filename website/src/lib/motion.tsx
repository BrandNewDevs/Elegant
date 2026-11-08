import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/** True until the browser says motion is fine, so nothing moves before we know. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Whether an element has scrolled into view, once. `armed` is false on the server and for anything already on screen at
 * load, so prerendered content is never hidden.
 */
export function useInViewOnce<T extends Element>(threshold = 0.2) {
  const ref = useRef<T>(null)
  const reduced = useReducedMotion()
  const [state, setState] = useState<'shown' | 'waiting' | 'entering'>('shown')

  useEffect(() => {
    const element = ref.current
    if (!element || reduced) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setState((s) => (s === 'waiting' ? 'entering' : s))
          observer.disconnect()
        } else {
          setState((s) => (s === 'shown' ? 'waiting' : s))
        }
      },
      { threshold },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [reduced, threshold])

  return { ref, state }
}

/** Fades its content up into place the first time it scrolls into view. `delay` staggers siblings. */
export function Reveal({
  as: Tag = 'div',
  delay = 0,
  className,
  children,
}: {
  as?: 'div' | 'section' | 'p'
  delay?: number
  className?: string
  children: React.ReactNode
}) {
  const { ref, state } = useInViewOnce<HTMLDivElement>()
  return (
    <Tag
      ref={ref}
      className={cn(
        state === 'waiting' && 'translate-y-4 opacity-0',
        state === 'entering' && 'transition-[opacity,translate] duration-700 ease-out',
        className,
      )}
      style={state === 'entering' ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
