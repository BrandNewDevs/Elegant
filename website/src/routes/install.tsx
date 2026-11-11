import { createFileRoute } from '@tanstack/react-router'

import { DownloadButton } from '@/components/download-button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { DISPLAY_NAME, REPO_URL, VERSION } from '@/site'

export const Route = createFileRoute('/install')({
  head: () => ({ meta: [{ title: `Install ${DISPLAY_NAME}` }] }),
  component: Install,
})

function Install() {
  return (
    <div className="mx-auto max-w-3xl animate-rise px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Install {DISPLAY_NAME}</h1>
      <p className="mt-4 leading-relaxed text-muted-foreground">
        You need an Apple Silicon Mac on macOS 14.2 or later. It takes a couple of minutes, most of
        it spent allowing the app once in System Settings.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <DownloadButton />
        <span className="text-sm text-muted-foreground">Version {VERSION}</span>
      </div>

      <ol className="mt-12 space-y-10">
        <Step n={1} title="Open the .dmg and drag the app to Applications" />
        <Step n={2} title="Open it once, then choose Done">
          <p>
            macOS blocks the first launch because {DISPLAY_NAME} is signed with a personal
            certificate rather than an Apple Developer ID, so it isn't notarized. The dialog offers{' '}
            <b>Done</b> and <b>Move to Trash</b>; choose <b>Done</b>.
          </p>
        </Step>
        <Step n={3} title="Allow it in Privacy & Security">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open <b>System Settings → Privacy &amp; Security</b>.
            </li>
            <li>
              Scroll to the <b>Security</b> section, which says {DISPLAY_NAME} was blocked.
            </li>
            <li>
              Click <b>Open Anyway</b>. It appears only after a blocked launch, for about an hour.
            </li>
            <li>
              Confirm with your password or Touch ID, then click <b>Open</b>.
            </li>
          </ol>
          <p className="mt-3">
            On macOS 14 you can also Control-click the app and choose <b>Open</b>.
          </p>
        </Step>
        <Step n={4} title="Follow onboarding">
          <p>
            Onboarding asks for your name (optional), then walks through the microphone and
            system-audio permissions. The speech models download on first use.
          </p>
        </Step>
      </ol>

      <Separator className="my-12" />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Local Summaries need Ollama</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Install{' '}
              <a href="https://ollama.com" className="text-primary underline-offset-4 hover:underline">
                Ollama
              </a>
              , then pull the summary model:
            </p>
            <Code>ollama pull gemma3:4b</Code>
            <p>Or choose Gemini in Settings with your own API key.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Skip the Gatekeeper dialog</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Optionally, remove the quarantine flag macOS puts on downloaded files:</p>
            <Code>xattr -dr com.apple.quarantine /Applications/{DISPLAY_NAME}.app</Code>
          </CardContent>
        </Card>
      </div>

      <p className="mt-10 text-sm text-muted-foreground">
        From version 0.1.3 on, {DISPLAY_NAME} updates itself. To build from source, see the{' '}
        <a href={REPO_URL} className="text-primary underline-offset-4 hover:underline">
          README on GitHub
        </a>
        .
      </p>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium">
        {n}
      </span>
      <div className="pt-1">
        <h3 className="font-semibold">{title}</h3>
        {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
      </div>
    </li>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
      <code>{children}</code>
    </pre>
  )
}
