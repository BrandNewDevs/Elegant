import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_KINDS, type ModelFile, type ModelKind } from "../shared/model-kinds.js";

export { MODEL_KINDS, type ModelFile, type ModelKind } from "../shared/model-kinds.js";

/**
 * Where the engine keeps each kind, under the `modelsDirectory` it was given: WhisperKit puts its variants in
 * `argmaxinc/whisperkit-coreml` and the tokenizer in `openai`, and SpeakerKit puts its models in `argmaxinc/speakerkit-coreml`.
 * Whole folders, so a variant the app no longer uses is cleaned up with the one it does.
 */
const FOLDERS: Record<ModelKind, string[][]> = {
  speech: [["models", "argmaxinc", "whisperkit-coreml"], ["models", "openai"]],
  speaker: [["models", "argmaxinc", "speakerkit-coreml"]],
};

const folders = (modelsDirectory: string, kind: ModelKind) => FOLDERS[kind].map((parts) => join(modelsDirectory, ...parts));

/** The size of a folder, counting files only and never following a link out of it; 0 when it does not exist. */
async function folderBytes(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await folderBytes(full);
    else if (entry.isFile()) total += (await lstat(full)).size;
  }
  return total;
}

/** What is downloaded, as the engine left it on disk. */
export async function modelFiles(modelsDirectory: string): Promise<ModelFile[]> {
  return Promise.all(
    MODEL_KINDS.map(async (kind) => {
      const bytes = (await Promise.all(folders(modelsDirectory, kind).map(folderBytes))).reduce((sum, n) => sum + n, 0);
      return { kind, present: bytes > 0, bytes };
    }),
  );
}

/** Deletes one kind of model. The next download or Transcript fetches it again. */
export async function removeModelFiles(modelsDirectory: string, kind: ModelKind): Promise<void> {
  for (const path of folders(modelsDirectory, kind)) await rm(path, { recursive: true, force: true });
}
