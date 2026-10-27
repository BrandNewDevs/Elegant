import type { Setup } from "../setup/setup.js";

export interface LaunchMeetings {
  show(): void;
}

export interface LaunchOnboarding {
  show(): void;
  /** Whether the onboarding window is open. */
  readonly isOpen: boolean;
  /** Runs each time the window closes, whether the person finished onboarding or closed it early. */
  onClosed(listener: () => void): void;
}

/**
 * Decides which window a launch opens. Opened by hand, the app shows the Meetings window, since the menu-bar item alone is
 * easy to miss; opened at login it stays quiet. Onboarding comes first: when a permission is missing only the onboarding
 * window opens, and the Meetings window follows once it closes, whether the person finished or closed it early (Settings
 * in the Meetings window still shows what is missing). At login that follow-up is skipped too, because onboarding is the
 * only thing a login launch opens.
 */
export class Launch {
  constructor(
    private readonly setup: Setup,
    private readonly meetings: LaunchMeetings,
    private readonly onboarding: LaunchOnboarding,
    private readonly wasOpenedAtLogin: boolean,
  ) {
    onboarding.onClosed(() => {
      if (!wasOpenedAtLogin) meetings.show();
    });
  }

  /** Opens the first window. Waits for macOS to report the permissions only when what was remembered says one is missing. */
  start(): void {
    if (this.setup.permissionsGranted) {
      // Earlier launches got every permission; Meetings show at once, and onboarding opens over them if one was revoked.
      if (!this.wasOpenedAtLogin) this.meetings.show();
      this.setup.onPermissionsChecked(() => this.showOnboardingIfNeeded());
      return;
    }
    // Possibly the first launch. Which windows open depends on what macOS says, so nothing shows until it has said.
    this.setup.onPermissionsChecked(() => {
      if (!this.showOnboardingIfNeeded() && !this.wasOpenedAtLogin) this.meetings.show();
    });
  }

  /** The Meetings window for a request to open the app (the Dock icon, the menu bar item, a second launch), unless onboarding is still open. */
  open(): void {
    if (this.onboarding.isOpen) this.onboarding.show();
    else this.meetings.show();
  }

  /** Opens onboarding if a permission is missing, even at login, because nothing can be recorded without them. */
  private showOnboardingIfNeeded(): boolean {
    if (this.setup.permissionsGranted) return false;
    this.onboarding.show();
    return true;
  }
}
