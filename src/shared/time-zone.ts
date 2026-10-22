/** The computer's zone as the platform reports it now; UTC when it reports none. */
export function systemTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
/** An IANA zone this platform knows. */
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
/** The zone times are shown in: the chosen one, or System, which follows the computer on every launch. */
export function displayTimeZone(setting: string | undefined): string { return validTimeZone(setting) ? setting : systemTimeZone(); }
