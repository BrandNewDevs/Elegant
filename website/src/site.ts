// The app's config and package.json are the single source for the name, repository and version.
import { DISPLAY_NAME, RELEASES_REPO } from '../../app/src/config'
import appPackage from '../../app/package.json'

export { DISPLAY_NAME }

export const VERSION = appPackage.version

export const REPO_URL = `https://github.com/${RELEASES_REPO}`
export const RELEASES_URL = `${REPO_URL}/releases`
/** The .dmg the Release workflow attaches to the v<version> release. */
export const DMG_URL = `${RELEASES_URL}/download/v${VERSION}/${DISPLAY_NAME}-${VERSION}.dmg`
