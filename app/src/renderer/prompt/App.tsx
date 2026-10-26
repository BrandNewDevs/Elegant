import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function PromptApp() {
  const [app, setApp] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = window.electron.prompt.onState((state) => setApp(state.app));
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
  }, [app]);

  if (!app) return null;

  return (
    <div ref={cardRef} className="select-none bg-transparent p-0">
      <Card className="flex items-center gap-3.5 rounded-2xl border-border/80 bg-card/95 px-4 py-3.5 shadow-lg backdrop-blur-sm">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/40 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold leading-tight break-words">{app} is using your microphone</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Record this Meeting? Nothing is kept unless you do.</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button type="button" size="sm" variant="destructive" onClick={() => window.electron.prompt.choose("record")}>
            Record
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => window.electron.prompt.choose("notNow")}>
            Not now
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => window.electron.prompt.choose("never")}>
            Never for this app
          </Button>
        </div>
      </Card>
    </div>
  );
}
