import { mkdtemp, mkdir, symlink, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { privateOutputPath } from "./private-path.js";

it("keeps private output outside the repository even through file and directory symlinks", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "private-evaluation-"));
  try {
    const root = join(scratch, "repo");
    await mkdir(root);
    await writeFile(join(root, "result.json"), "{}");
    await symlink(root, join(scratch, "alias"), "dir");
    await symlink(join(root, "result.json"), join(scratch, "file.json"));
    await symlink(join(root, "not-yet-created.json"), join(scratch, "dangling.json"));
    const canonicalRoot = await realpath(root);
    await expect(privateOutputPath(canonicalRoot, join(scratch, "alias", "new.json"))).rejects.toThrow("outside");
    await expect(privateOutputPath(canonicalRoot, join(scratch, "file.json"))).rejects.toThrow("outside");
    await expect(privateOutputPath(canonicalRoot, join(scratch, "dangling.json"))).rejects.toThrow("outside");
    expect(await privateOutputPath(canonicalRoot, join(scratch, "allowed.json"))).toBe(join(await realpath(scratch), "allowed.json"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
