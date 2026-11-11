import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { DISPLAY_NAME } from '@/site'
import appCss from '../styles.css?url'

const DESCRIPTION =
  'A macOS menu-bar app that notices your online calls, records them, and writes a Transcript and Summary on your Mac.'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: `${DISPLAY_NAME}: private meeting notes for your Mac` },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:title', content: DISPLAY_NAME },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:image', content: '/social-preview.png' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-svh flex-col">
        <a
          href="#content"
          className="sr-only z-50 rounded-md bg-foreground px-4 py-2 text-background focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="content" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
        <SiteFooter />
        <Scripts />
      </body>
    </html>
  )
}
