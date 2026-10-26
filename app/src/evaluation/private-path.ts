import { realpath } from "node:fs/promises";
import { basename, dirname, relative, isAbsolute, resolve, sep } from "node:path";

export function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Resolve symlinks before writing private results. The parent must exist, as required by writeFile. */
export async function privateOutputPath(root: string, path: string): Promise<string> {
  const absolute = resolve(path);
  let canonical: string;
  try { canonical = await realpath(absolute); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    canonical = resolve(await realpath(dirname(absolute)), basename(absolute));
  }
  if (!isOutside(root, canonical)) throw new Error("Private evaluation output must be outside the repository, including through symlinks");
  return canonical;
}
