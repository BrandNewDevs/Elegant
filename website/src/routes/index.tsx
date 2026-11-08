import { Link, createFileRoute } from '@tanstack/react-router'
import { useRef } from 'react'

import { DownloadButton, NotAMacNote } from '@/components/download-button'
import { HeroBackdrop } from '@/components/hero-backdrop'
import { Mark, WaveRule } from '@/components/logo'
import { Reveal } from '@/lib/motion'
import { DISPLAY_NAME, REPO_URL, VERSION } from '@/site'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <>
      <Hero />
      <div className="mx-auto max-w-6xl px-4 pt-16 sm:px-6 lg:pt-0">
        <WaveRule />
      </div>
      <Details />
      <Privacy />
      <Closing />
    </>
  )
}

/** Hero load-in: the text rises in a stagger, then the window, then the Prompt arrives as it does on a call. */
function Hero() {
  const area = useRef<HTMLDivElement>(null)
  return (
    <div ref={area} className="relative isolate">
      <HeroBackdrop target={area} />
      <section className="mx-auto grid max-w-6xl items-center gap-14 px-4 pt-10 sm:px-6 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:pt-0 lg:pb-8">
        <div>
          <Mark speak="load" className="mb-6 size-[72px] animate-pop drop-shadow-md" />
          <h1 className="animate-rise text-4xl font-semibold tracking-tight text-balance [animation-delay:100ms] sm:text-5xl">
            Notes for every call, written on your Mac.
          </h1>
          <p className="mt-5 max-w-md animate-rise text-lg text-pretty text-muted-foreground [animation-delay:200ms]">
            {DISPLAY_NAME} notices when you join a call, asks if you want to record it, and gives you
            a Transcript and Summary afterwards. Nothing is uploaded to do it.
          </p>
          <div className="mt-8 flex animate-rise flex-col items-start gap-3 [animation-delay:300ms]">
            <DownloadButton />
            <p className="text-sm text-muted-foreground">
              Version {VERSION} · macOS 14.2+ · Apple Silicon ·{' '}
              <Link to="/install" className="underline underline-offset-4 hover:text-foreground">
                Install guide
              </Link>
            </p>
            <NotAMacNote />
          </div>
        </div>

        <figure className="relative pb-10 lg:pb-0">
          <img
            src="/screenshots/meeting.png"
            alt="The Meetings window showing a Zoom Meeting's Summary: a TL;DR and what each Participant said"
            width={960}
            height={620}
            fetchPriority="high"
            className="w-full animate-pop rounded-[10px] shadow-2xl ring-1 shadow-black/15 ring-black/10 [animation-delay:350ms]"
          />
          <img
            src="/screenshots/prompt.png"
            alt="The Prompt: Record this Meeting? with Record and Never for this app"
            width={640}
            height={110}
            className="absolute bottom-0 -left-2 w-[78%] animate-rise drop-shadow-xl [animation-delay:1000ms] sm:-left-8 lg:-bottom-8"
          />
        </figure>
      </section>
    </div>
  )
}

const DETAILS = [
  {
    title: 'It asks first.',
    body: 'When Zoom, Teams, Slack, FaceTime or a browser tab takes the microphone, a small Prompt appears. Say yes late and you still get the start of the call; the last few minutes are held in memory until you decide.',
  },
  {
    title: 'You and everyone else, separately.',
    body: 'Your microphone and the system audio are recorded as two tracks. Other voices are told apart and labelled Speaker 1, Speaker 2, until you rename them.',
  },
  {
    title: 'Summaries you can check.',
    body: 'A TL;DR, then what each Participant said. Each point links to the passage it came from, so you can click a timestamp and read it in context.',
  },
  {
    title: 'Ask a Meeting a question.',
    body: '“When did we agree to ship?” Chat answers from one Meeting’s Transcript and shows where it found the answer.',
  },
  {
    title: 'Find it later.',
    body: 'Search every Meeting at once, export one to Markdown, or delete it and everything that came with it.',
  },
  {
    title: 'Quiet by default.',
    body: 'It lives in the menu bar. Recording only stops when you stop it, and the audio is deleted once the Transcript is done unless you choose to keep it.',
  },
]

function Details() {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-16 pb-24 sm:px-6 sm:pb-32">
      <Reveal>
        <h2 className="max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">
          What happens on a call
        </h2>
      </Reveal>
      <div className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {DETAILS.map(({ title, body }, i) => (
          <Reveal
            as="p"
            key={title}
            delay={(i % 3) * 120}
            className="leading-relaxed text-muted-foreground"
          >
            <span className="font-medium text-foreground">{title}</span> {body}
          </Reveal>
        ))}
      </div>
    </section>
  )
}

function Privacy() {
  return (
    <section className="border-y bg-muted/50">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[2fr_3fr]">
        <Reveal>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Your calls stay on your Mac.
          </h2>
          <div className="mt-6 space-y-4 leading-relaxed text-muted-foreground">
            <p>
              Recording, transcription (WhisperKit) and telling speakers apart all run locally.
              Summaries and Chat use a model on your Mac through{' '}
              <a href="https://ollama.com" className="text-foreground underline underline-offset-4">
                Ollama
              </a>
              .
            </p>
            <p>
              If you’d rather not run a model yourself, you can switch Summaries and Chat to Gemini
              with your own API key. It’s off until you turn it on, and audio never goes with it.
            </p>
          </div>
        </Reveal>
        <Reveal delay={150}>
          <img
            src="/screenshots/settings-providers.png"
            alt="Settings, Providers: Ollama (Local, In use) and Gemini (Cloud)"
            width={960}
            height={620}
            loading="lazy"
            className="w-full rounded-[10px] shadow-xl ring-1 shadow-black/10 ring-black/10"
          />
        </Reveal>
      </div>
    </section>
  )
}

function Closing() {
  return (
    <Reveal as="section" className="mx-auto max-w-6xl px-4 py-24 text-center sm:px-6">
      <Mark speak="view" tile={false} className="mx-auto mb-6 size-16" />
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Try it on your next call.
      </h2>
      <p className="mt-3 text-muted-foreground">
        Free and{' '}
        <a href={REPO_URL} className="underline underline-offset-4 hover:text-foreground">
          open source
        </a>
        . English only for now.
      </p>
      <div className="mt-8 flex justify-center">
        <DownloadButton />
      </div>
    </Reveal>
  )
}
