// TuRu - source health state machine (pure functions, no I/O) shared by scan-source.
//
// healthy -> failing (1-2 consecutive failures) -> backed_off (3+, exponential next_scan_at, capped)
// -> attention_required (>= attentionAfter: still scheduled, surfaced prominently in admin/reports)
// -> auto_paused (is_active=false) ONLY for hard, persistent access failures (gone_404 /
// access_403_waf) after autoPauseAfter failures, and NEVER for high-value sources (priority >= 8)
// or for transient/extraction kinds (timeout_network / parse_extraction / content_changed / unknown)
// - those cap at attention_required with maximum backoff. A paused source keeps its row, gets an
// explicit disabled_reason, and is counted as a coverage gap by the reports (never silently gone).

export type FailureKind = 'gone_404' | 'access_403_waf' | 'timeout_network' | 'parse_extraction' | 'content_changed' | 'unknown';
export type HealthStatus = 'healthy' | 'failing' | 'backed_off' | 'attention_required' | 'auto_paused';

export const HIGH_VALUE_PRIORITY = 8;
const HARD_FAILURE_KINDS: FailureKind[] = ['gone_404', 'access_403_waf'];

export interface HealthSettings {
  attentionAfter: number; // default 5
  autoPauseAfter: number; // default 10
  backoffMaxHours: number; // default 168
}

export function readHealthSettings(settings: Record<string, unknown>): HealthSettings {
  return {
    attentionAfter: Number(settings.source_attention_after_failures ?? 5),
    autoPauseAfter: Number(settings.source_auto_pause_after_failures ?? 10),
    backoffMaxHours: Number(settings.source_backoff_max_hours ?? 168),
  };
}

export function classifyFetchFailure(input: { status?: number; errorName?: string; errorMessage?: string; bodySnippet?: string }): FailureKind {
  const { status, errorName = '', errorMessage = '', bodySnippet = '' } = input;
  if (status === 404 || status === 410) return 'gone_404';
  if (status === 401 || status === 403 || status === 429) return 'access_403_waf';
  if (status === 503 && /cloudflare|attention required|just a moment/i.test(bodySnippet)) return 'access_403_waf';
  if (/timeout|abort/i.test(errorName) || /timed out|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(errorMessage)) return 'timeout_network';
  if (status && status >= 500) return 'timeout_network'; // server-side transient, retry with backoff
  return 'unknown';
}

export interface HealthTransitionInput {
  consecutiveFailures: number; // AFTER incrementing for this failed scan
  failureKind: FailureKind;
  priority: number;
  baseFrequencyHours: number;
  settings: HealthSettings;
}

export interface HealthTransition {
  healthStatus: HealthStatus;
  isActive: boolean;
  disabledReason: string | null;
  nextScanDelayHours: number;
}

export function nextSourceHealthOnFailure(input: HealthTransitionInput): HealthTransition {
  const { consecutiveFailures: f, failureKind, priority, baseFrequencyHours, settings } = input;
  const backoff = Math.min(baseFrequencyHours * Math.pow(2, Math.max(0, f - 2)), settings.backoffMaxHours);

  const canAutoPause = HARD_FAILURE_KINDS.includes(failureKind) && priority < HIGH_VALUE_PRIORITY;
  if (f >= settings.autoPauseAfter && canAutoPause) {
    return {
      healthStatus: 'auto_paused', isActive: false,
      disabledReason: `auto_paused: ${f} consecutive ${failureKind} failures`,
      nextScanDelayHours: settings.backoffMaxHours,
    };
  }
  if (f >= settings.attentionAfter) {
    return { healthStatus: 'attention_required', isActive: true, disabledReason: null, nextScanDelayHours: backoff };
  }
  if (f >= 3) return { healthStatus: 'backed_off', isActive: true, disabledReason: null, nextScanDelayHours: backoff };
  return { healthStatus: 'failing', isActive: true, disabledReason: null, nextScanDelayHours: baseFrequencyHours };
}

export function healthOnSuccess(): { healthStatus: HealthStatus; consecutiveFailures: number; disabledReason: null } {
  return { healthStatus: 'healthy', consecutiveFailures: 0, disabledReason: null };
}

// Worst-of helper for a scan that touched several pages: hard access failures dominate, then
// transient network, then extraction, then unknown. content_changed is informational only.
const KIND_SEVERITY: Record<FailureKind, number> = {
  gone_404: 5, access_403_waf: 5, timeout_network: 4, parse_extraction: 3, unknown: 2, content_changed: 1,
};
export function worstFailureKind(kinds: FailureKind[]): FailureKind | null {
  if (kinds.length === 0) return null;
  return kinds.reduce((worst, k) => (KIND_SEVERITY[k] > KIND_SEVERITY[worst] ? k : worst), kinds[0]);
}
