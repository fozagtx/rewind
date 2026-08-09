/**
 * Redaction, a hard security boundary.
 *
 * Env var values are live credentials. A leaked DATABASE_URL in a demo
 * screenshot is a real failure, so no raw secret value ever reaches a
 * ChangeRow, a log line, an error message, or the UI.
 */

import type { ServiceConfig } from './types.ts';

const SECRET_KEY_PATTERN =
  /(_KEY|_SECRET|_TOKEN|_PASSWORD|PASSWORD|SECRET|TOKEN|CREDENTIAL|DSN|_URL)$/i;

/**
 * True when this env key must never have its value rendered.
 *
 * Two independent signals: the key lives under `envSecrets` (Zerops already
 * classified it as secret), or the key name matches a known secret shape.
 */
export function isSecretField(service: ServiceConfig, key: string): boolean {
  if (service.envSecrets && Object.prototype.hasOwnProperty.call(service.envSecrets, key)) {
    return true;
  }
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Render a secret's transition without revealing it.
 *
 * Deliberately returns a state word, not a masked value: `"****"` still leaks
 * length, and a partial prefix still leaks entropy.
 */
export function redactValue(v: unknown): string {
  if (v === null || v === undefined) return '(deleted)';
  if (typeof v === 'string' && v.length === 0) return '(empty)';
  return '(set)';
}

/** Render a before/after pair for a secret field as one word. */
export function redactTransition(before: unknown, after: unknown): string {
  const had = before !== null && before !== undefined;
  const has = after !== null && after !== undefined;
  if (!had && has) return '(set)';
  if (had && !has) return '(deleted)';
  if (had && has) return '(changed)';
  return '(absent)';
}

/**
 * Scrub anything secret-shaped out of free text before it is logged or thrown.
 * Last line of defence for error messages that may embed a response body.
 */
export function scrubText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:access|api)?[_-]?(?:token|key|secret|password)"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi,
      '$1[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:[^@\s]+@/gi, (m) =>
      m.replace(/:\/\/[^:/\s]+:[^@\s]+@/, '://[redacted]@'));
}
