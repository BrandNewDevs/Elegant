/** Follows the macOS appearance: adds the `dark` class shadcn's dark theme keys on, and keeps it in step when it changes. */
export function followSystemTheme(root: HTMLElement = document.documentElement, query: MediaQueryList = window.matchMedia("(prefers-color-scheme: dark)")): () => void {
  const apply = () => root.classList.toggle("dark", query.matches);
  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}
