export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
