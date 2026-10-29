import { toast } from "sonner";

/** Asks the app to restart into the ready update; says why in a toast when it will not (a Recording or AI work is going on). */
export async function restartForUpdate(): Promise<void> {
  const result = await window.electron.meetings.restartForUpdate();
  if (!result.ok) toast.error(result.reason, { id: "update-refused", duration: 8000 });
}
