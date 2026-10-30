import { BellOff, Circle, Mic, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function PromptApp() {
  const [shown, setShown] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = window.electron.prompt.onState(() => setShown(true));
    window.electron.prompt.ready();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = () => window.electron.prompt.resize(Math.ceil(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

  // The window is never given focus, so Esc only works once the person has clicked into it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.electron.prompt.choose("close");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!shown) return null;

  return (
    <div ref={cardRef} className="select-none bg-transparent p-3">
      <Card className="relative flex items-center gap-3.5 rounded-2xl border-border/80 bg-card/95 px-4 py-3.5 shadow-lg backdrop-blur-sm">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/20" aria-hidden />
          <Mic className="relative size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold leading-tight">Record this Meeting?</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Nothing is kept unless you choose to record.</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button type="button" size="sm" variant="destructive" onClick={() => window.electron.prompt.choose("record")}>
            <Circle className="fill-current" aria-hidden />
            Record
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => window.electron.prompt.choose("never")}>
            <BellOff aria-hidden />
            Never for this app
          </Button>
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Close"
          title="Close"
          className="absolute -right-2.5 -top-2.5 size-6 rounded-full bg-card text-muted-foreground shadow-md hover:text-foreground [&_svg]:size-3.5"
          onClick={() => window.electron.prompt.choose("close")}
        >
          <X aria-hidden />
        </Button>
      </Card>
    </div>
  );
}
