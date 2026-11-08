import { Link } from '@tanstack/react-router'

import { DISPLAY_NAME, RELEASES_URL, REPO_URL, VERSION } from '@/site'

export function SiteFooter() {
  return (
    <footer className="mx-auto flex w-full max-w-6xl flex-col gap-3 border-t px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
      <p>
        {DISPLAY_NAME} {VERSION}. MIT licensed.
      </p>
      <nav className="flex gap-6 sm:ml-auto">
        <Link to="/install" className="hover:text-foreground">
          Install
        </Link>
        <a href={RELEASES_URL} className="hover:text-foreground">
          Releases
        </a>
        <a href={REPO_URL} className="hover:text-foreground">
          GitHub
        </a>
      </nav>
    </footer>
  )
}
