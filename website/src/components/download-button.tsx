import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DISPLAY_NAME, DMG_URL } from '@/site'

export function DownloadButton() {
  return (
    <Button
      asChild
      size="lg"
      className="h-11 rounded-full bg-foreground px-6 text-[15px] text-background hover:bg-foreground/85"
    >
      <a href={DMG_URL}>Download for Mac</a>
    </Button>
  )
}

/** iPads report themselves as Macs, so touch support tells them apart. */
function isMac() {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
    navigator.platform
  return /mac/i.test(platform) && navigator.maxTouchPoints < 2
}

/**
 * Anyone can read the site, but the app only runs on a Mac. Visitors on anything else are told so next to the
 * download, rather than finding out after it.
 */
export function NotAMacNote() {
  const [show, setShow] = useState(false)
  useEffect(() => setShow(!isMac()), [])
  if (!show) return null
  return (
    <p role="note" className="max-w-sm rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
      {DISPLAY_NAME} runs on Macs with Apple Silicon. You can read on here and download it later
      from your Mac.
    </p>
  )
}
