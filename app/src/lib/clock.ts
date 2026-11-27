/**
 * Server clock (MER-75, R7.3): the countdown uses the offset between the API's `serverTime`
 * and the local clock, so a skewed client clock does not move the close.
 */

/** serverTime − local time in ms, taking the server reading as of the middle of the round trip. */
export function offsetFrom(serverTimeIso: string, receivedAtMs: number, rttMs = 0): number {
  return Date.parse(serverTimeIso) - (receivedAtMs - rttMs / 2);
}

export function serverNow(offsetMs: number, localNowMs = Date.now()): number {
  return localNowMs + offsetMs;
}

/** "2h 14m 05s", "14m 05s", "5s". */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}
