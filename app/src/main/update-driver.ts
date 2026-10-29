import { autoUpdater as squirrel } from "electron";
import electronUpdater from "electron-updater";
import { isAcceptableFeed } from "../core/update-check.js";
import type { UpdateDriver } from "../core/updater.js";

/**
 * The real update driver: electron-updater reading the releases of the repository named in `app-update.yml`
 * (`scripts/package.sh` writes it into the packaged app), with macOS's own updater (Squirrel.Mac) doing the install.
 * Squirrel accepts an update only when it satisfies the running app's designated requirement, which pins the
 * signing certificate, so a release signed with anything else is refused whatever the feed says. Packaged app only.
 */
export function createUpdateDriver({ userAgent }: { userAgent: string }): UpdateDriver {
  const updater = electronUpdater.autoUpdater;
  // The download starts after the check, once the person's setting and the version have been looked at.
  updater.autoDownload = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.requestHeaders = { "User-Agent": userAgent, "Accept-Language": "en" };
  // electron-updater tags every request with a random id that it saves in the data folder, for staged rollouts, which are not
  // used here. An empty one is sent instead, so nothing that identifies the install leaves the Mac and no id is written.
  Object.defineProperty(updater, "stagingUserIdPromise", { value: { value: Promise.resolve("") } });
  // An "error" event nobody listens to throws; the failures that matter reach the callers below.
  updater.on("error", () => {});

  return {
    async check() {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) return undefined;
      if (!isAcceptableFeed(result.updateInfo.files)) throw new Error("the release does not list its files the way the updater needs");
      return result.updateInfo.version;
    },

    // electron-updater is done once the zip is in the cache and handed to Squirrel; Squirrel then checks the signature and
    // reports an error or `update-downloaded` a moment later, and only that makes the update ready.
    download(onProgress) {
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          updater.off("error", finish);
          updater.off("download-progress", progress);
          squirrel.off("update-downloaded", ready);
          if (error) reject(error);
          else resolve();
        };
        const progress = ({ percent }: { percent: number }) => onProgress(percent);
        const ready = () => finish();
        updater.on("error", finish);
        updater.on("download-progress", progress);
        squirrel.on("update-downloaded", ready);
        updater.downloadUpdate().catch(finish);
      });
    },

    install() {
      updater.quitAndInstall();
    },
  };
}
