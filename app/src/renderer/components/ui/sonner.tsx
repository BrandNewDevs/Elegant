import { Toaster as Sonner, type ToasterProps } from "sonner"

// The page already follows the system appearance through the `dark` class (see lib/theme.ts), so the toasts do too.
// Every toast has a close button, on its top-right corner and half outside it (Sonner's own values for a right-to-left page, which
// it otherwise puts on the left).
const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="system"
    className="toaster group"
    closeButton
    style={
      {
        "--toast-close-button-start": "unset",
        "--toast-close-button-end": "0",
        "--toast-close-button-transform": "translate(35%, -35%)",
        "--normal-bg": "hsl(var(--popover))",
        "--normal-text": "hsl(var(--popover-foreground))",
        "--normal-border": "hsl(var(--border))",
      } as React.CSSProperties
    }
    {...props}
  />
)

export { Toaster }
