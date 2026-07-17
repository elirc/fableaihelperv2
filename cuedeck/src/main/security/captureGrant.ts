import { CAPTURE_GRANT_TTL_MS } from '../../shared/constants';

/**
 * One-use, expiring capture grant (spec §5.2-E, §17.10).
 *
 * The display-media handler denies every request unless the renderer has
 * armed a grant via `capture:arm` within the TTL. Consuming the grant
 * clears it, so a second getDisplayMedia call needs a fresh explicit arm.
 */
export class CaptureGrant {
  private armedSessionId: string | null = null;
  private armedAt = 0;

  constructor(
    private readonly ttlMs: number = CAPTURE_GRANT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Arm the grant for one upcoming getDisplayMedia call. Re-arming
   * overwrites any pending grant (there is never more than one), and the
   * grant self-expires after `ttlMs` even if never consumed.
   */
  arm(sessionId: string): { expiresAt: number } {
    this.armedSessionId = sessionId;
    this.armedAt = this.now();
    return { expiresAt: this.armedAt + this.ttlMs };
  }

  /** Consume the grant if armed and unexpired. */
  consume(): boolean {
    const valid = this.armedSessionId !== null && this.now() - this.armedAt <= this.ttlMs;
    this.armedSessionId = null;
    this.armedAt = 0;
    return valid;
  }

  disarm(): void {
    this.armedSessionId = null;
    this.armedAt = 0;
  }
}
