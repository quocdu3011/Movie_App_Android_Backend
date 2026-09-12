import { HttpException } from '@nestjs/common';
import { STREAMING_CONFIG, StreamingConfig } from './streaming.config';
import { Inject, Injectable } from '@nestjs/common';

interface CircuitState { failures: number; openUntil: number; probeInFlight: boolean }

@Injectable()
export class SourceCircuit {
  private readonly states = new Map<string, CircuitState>();

  constructor(@Inject(STREAMING_CONFIG) private readonly config: StreamingConfig) {}

  beforeResolve(sourceItemId: string, retryAfter: Date | string | null): void {
    const now = Date.now();
    const state = this.states.get(sourceItemId);
    const retryAt = retryAfter ? new Date(retryAfter).getTime() : 0;
    const blockedUntil = Math.max(state?.openUntil ?? 0, Number.isFinite(retryAt) ? retryAt : 0);
    if (blockedUntil > now) this.reject(sourceItemId, blockedUntil);
    if (state && state.failures >= this.config.circuitFailureThreshold) {
      if (state.probeInFlight) this.reject(sourceItemId, now + this.config.sourceRetryBaseMs);
      state.probeInFlight = true;
    }
  }

  recordFailure(sourceItemId: string): Date {
    const state = this.states.get(sourceItemId) ?? { failures: 0, openUntil: 0, probeInFlight: false };
    state.failures += 1;
    state.probeInFlight = false;
    const exponent = Math.max(0, state.failures - this.config.circuitFailureThreshold);
    const backoffMs = Math.min(60_000, this.config.sourceRetryBaseMs * 2 ** Math.min(exponent, 6));
    state.openUntil = Date.now() + backoffMs;
    this.states.set(sourceItemId, state);
    return new Date(state.openUntil);
  }

  recordSuccess(sourceItemId: string): void {
    this.states.delete(sourceItemId);
  }

  private reject(sourceItemId: string, until: number): never {
    const retryAfterSeconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    throw new HttpException({
      code: 'EXTERNAL_SOURCE_UNAVAILABLE',
      message: 'Playback source is in its retry backoff window',
      details: { sourceItemId, retryAfterSeconds },
    }, 503);
  }
}
