import { Controller, Get, Inject, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { Response } from 'express';
import { errorEnvelope, successEnvelope } from '@movie/shared-dto';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { AuthenticatedRequest } from '../auth/access-auth.guard';

@Controller('home')
export class HomeController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Get()
  async home(@Query('profileId') profileId: string, @Req() request: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const session = request.authSession;
    if (!session?.active || !session.userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId ?? '')) {
      response.status(400).json(errorEnvelope({ code: 'INVALID_PROFILE_ID', message: 'profileId must be a UUID' }, request.requestId ?? 'unknown'));
      return;
    }
    const headers = { authorization: `Bearer ${this.config.serviceToken}`, 'x-user-id': session.userId, 'x-caller-service': 'api-gateway', 'x-request-id': request.requestId ?? 'unknown' };
    let history: unknown;
    let catalogHome: Record<string, unknown>;
    try {
      const [historyResponse, catalogResponse] = await Promise.all([
        fetch(`${this.config.profileUrl}/profiles/${encodeURIComponent(profileId)}/watch-history`, { headers, signal: AbortSignal.timeout(5_000) }),
        fetch(`${this.config.catalogUrl}/catalog/home`, { headers, signal: AbortSignal.timeout(5_000) }),
      ]);
      if (historyResponse.status === 404) { response.status(404).json(errorEnvelope({ code: 'PROFILE_NOT_FOUND', message: 'Profile not found' }, request.requestId ?? 'unknown')); return; }
      if (!historyResponse.ok || !catalogResponse.ok) throw new Error('upstream unavailable');
      history = (await historyResponse.json() as { data?: unknown }).data;
      catalogHome = ((await catalogResponse.json() as { data?: Record<string, unknown> }).data ?? {});
    } catch {
      throw new ServiceUnavailableException('Home dependencies are unavailable');
    }
    let recommendation: Record<string, unknown> | null = null;
    if (this.config.recommendationUrl) {
      try {
        const upstream = await fetch(`${this.config.recommendationUrl}/internal/recommendations/${encodeURIComponent(profileId)}`, { headers, signal: AbortSignal.timeout(800) });
        if (upstream.ok) recommendation = ((await upstream.json() as { data?: Record<string, unknown> }).data ?? null);
      } catch { /* Recommendation is an optional Home section until G8. */ }
    }
    const fallback = catalogHome.newReleases ?? { type: 'fallback_empty', items: [] };
    response.setHeader('cache-control', 'no-store');
    response.status(200).json(successEnvelope({ profileId, sections: [
      { type: 'continue_watching', items: (history as { items?: unknown[] } | undefined)?.items ?? [] },
      recommendation ?? { type: 'fallback_new_releases', reason: 'recommendation_unavailable', items: (fallback as { items?: unknown[] }).items ?? [] },
      { type: 'catalog_new_releases', items: (fallback as { items?: unknown[] }).items ?? [] },
    ] }, request.requestId ?? 'unknown'));
  }
}
