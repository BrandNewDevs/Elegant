import { Toaster as Sonner, type ToasterProps } from "sonner"

// The page already follows the system appearance through the `dark` class (see lib/theme.ts), so the toasts do too.
const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="system"
    className="toaster group"
    style={
      {
        "--normal-bg": "hsl(var(--popover))",
        "--normal-text": "hsl(var(--popover-foreground))",
        "--normal-border": "hsl(var(--border))",
      } as React.CSSProperties
    }
    {...props}
  />
)

export { Toaster }
