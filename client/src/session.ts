// Session token storage. The token itself is a 256-bit random value issued
// by the server at login; the server stores only its SHA-256 hash, so this
// copy is the only usable one. Kept in localStorage so the session survives
// reopening the app; logout deletes it here and on the server.
const KEY = "qw-session-token";

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Storage unavailable: the session simply won't persist across opens.
  }
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
