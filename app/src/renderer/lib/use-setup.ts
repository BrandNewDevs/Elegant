import { useEffect, useState } from "react";
import type { SetupViewState } from "../../shared/setup-view-state";

/** The Setup state the main process pushes; null until the first push arrives. */
export function useSetup(): SetupViewState | null {
  const [view, setView] = useState<SetupViewState | null>(null);
  useEffect(() => {
    const unsubscribe = window.electron.setup.onState(setView);
    window.electron.setup.ready();
    return unsubscribe;
  }, []);
  return view;
}
