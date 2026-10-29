import * as React from "react"

import { cn } from "@/lib/utils"

interface TriggerProps {
  onClick: () => void
  "aria-expanded": boolean
  "aria-haspopup": "menu" | "dialog"
}

/**
 * A small click-to-open panel under its trigger, for a menu of actions or a short form. It closes on Escape, on a click
 * outside, and (for a menu) when an item is chosen. `role="menu"` panels get `menuitem` buttons from `MenuItem`.
 */
function Popover({
  trigger,
  role = "dialog",
  label,
  align = "right",
  className,
  children,
}: {
  trigger: (props: TriggerProps) => React.ReactNode
  role?: "menu" | "dialog"
  label: string
  align?: "left" | "right"
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])
  return (
    <div ref={root} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": role })}
      {open && (
        <div
          role={role}
          aria-label={label}
          className={cn(
            "absolute top-full z-40 mt-1 min-w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
          onClick={role === "menu" ? () => setOpen(false) : undefined}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function MenuItem({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

export { Popover, MenuItem }
