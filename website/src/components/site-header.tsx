import { Link } from '@tanstack/react-router'
import { Star } from 'lucide-react'

import { Wordmark } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { DISPLAY_NAME, REPO_URL } from '@/site'

export function SiteHeader() {
  return (
    <header className="mx-auto flex h-16 w-full max-w-6xl animate-rise items-center px-4 sm:px-6">
      <Link to="/" aria-label={`${DISPLAY_NAME} home`}>
        <Wordmark />
      </Link>
      <Button asChild variant="outline" size="sm" className="ml-auto rounded-full">
        <a href={REPO_URL}>
          <Star />
          Star on GitHub
        </a>
      </Button>
    </header>
  )
}
