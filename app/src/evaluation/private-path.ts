import { realpath, lstat, readlink } from "node:fs/promises";
import { basename, dirname, relative, isAbsolute, resolve, sep } from "node:path";

export function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Resolve symlinks before writing private results. The parent must exist, as required by writeFile. */
export async function privateOutputPath(root: string, path: string, depth = 0): Promise<string> {
  if (depth > 40) throw new Error("Too many private output symlinks");
  const absolute = resolve(path);
  let canonical: string;
  try { canonical = await realpath(absolute); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const stat = await lstat(absolute).catch((problem: NodeJS.ErrnoException) => {
      if (problem.code === "ENOENT") return undefined;
      throw problem;
    });
    if (stat?.isSymbolicLink()) return privateOutputPath(root, resolve(dirname(absolute), await readlink(absolute)), depth + 1);
    canonical = resolve(await realpath(dirname(absolute)), basename(absolute));
  }
  if (!isOutside(root, canonical)) throw new Error("Private evaluation output must be outside the repository, including through symlinks");
  return canonical;
}
