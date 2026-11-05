// What the main window's close button does, and what the notification says
// when it hides the window instead of quitting (2026-11-04).
//
// A hidden app can still spend real money, which is why this is written down
// and tested on its own: every case below is a decision about whether someone
// who pressed X is left with something running that they cannot see.

/** 'close' lets the window close, 'hide' goes to the tray, 'quit' quits the app. */
export type CloseAction = 'close' | 'hide' | 'quit';

export function closeAction(s: {
  platform: string;
  /** The Settings switch. */
  enabled: boolean;
  /** False during first-run setup and its replays. */
  onboarded: boolean;
  /** A quit is already under way. It must never be turned back into a hide. */
  quitting: boolean;
  visible: boolean;
}): CloseAction {
  if (s.quitting) return 'close';
  // Windows only: stock GNOME has no tray, so the app would vanish with no way
  // back, and on macOS the Dock icon reopens it (app.on('activate') in main.ts).
  if (s.platform !== 'win32' || !s.enabled) return 'close';
  // Setup explains nothing about the tray yet, and someone backing out of the
  // terms should not leave a background process behind.
  if (!s.onboarded) return 'close';
  // A hidden window has no X to press, so something outside the app is asking
  // it to exit. It gets a real quit, with the drain that closes out trades.
  // Not the installer's route in practice: its one soft taskkill lands on the
  // tray icon's helper window, and it force-kills about a second later.
  return s.visible ? 'hide' : 'quit';
}

export function trayNotice(liveArmed: boolean, liveBackAt: string | null = null): { title: string; body: string } {
  return {
    title: 'Krypto Mirror is still running',
    body: !liveArmed && liveBackAt
      ? `Live trading is off and comes back on by itself at ${liveBackAt}, when it can spend real money again. Click the tray icon to open the app, or right-click it to quit.`
      : liveArmed
      ? 'Live trading is ON and can still spend real money. Click the tray icon to open the app, or right-click it to quit.'
      : 'It is in the system tray with live trading off. Click the icon to open it, or right-click it to quit.',
  };
}
