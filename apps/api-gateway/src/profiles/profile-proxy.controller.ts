import { Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { Response } from 'express';
import { errorEnvelope } from '@movie/shared-dto';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { AuthenticatedRequest } from '../auth/access-auth.guard';

@Controller('profiles')
export class ProfileProxyController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', '/profiles', undefined, request, response);
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '/profiles', request.body, request, response);
  }

  @Patch(':profileId')
  update(@Param('profileId') profileId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('PATCH', `/profiles/${encodeURIComponent(profileId)}`, request.body, request, response);
  }

  @Delete(':profileId')
  remove(@Param('profileId') profileId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('DELETE', `/profiles/${encodeURIComponent(profileId)}`, undefined, request, response);
  }

  private async forward(
    method: string,
    path: string,
    body: unknown,
    request: AuthenticatedRequest,
    response: Response,
  ): Promise<void> {
    const session = request.authSession;
    if (!session?.active || !session.userId) throw new ServiceUnavailableException('Authenticated user context is missing');
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.profileUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          'x-user-id': session.userId,
          'x-request-id': request.requestId ?? 'unknown',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      response.status(503).json(errorEnvelope(
        { code: 'PROFILE_UNAVAILABLE', message: 'Profile service unavailable' },
        request.requestId ?? 'unknown',
      ));
      return;
    }
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-request-id', request.requestId ?? 'unknown');
    response.status(upstream.status);
    if (upstream.status === 204) {
      response.end();
      return;
    }
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }
}
