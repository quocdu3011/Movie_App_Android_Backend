import { Body, Controller, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { Response } from 'express';
import { errorEnvelope } from '@movie/shared-dto';
import { AuthenticatedRequest } from '../auth/access-auth.guard';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { RequireRoles } from '../auth/role.guard';

@Controller('streaming/playback-sessions')
export class StreamingProxyController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '', request, response, true);
  }

  @Post(':sessionId/heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', `/${encodeURIComponent(sessionId)}/heartbeat`, request, response);
  }

  @Post(':sessionId/progress')
  @HttpCode(HttpStatus.OK)
  progress(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', `/${encodeURIComponent(sessionId)}/progress`, request, response);
  }

  @Post(':sessionId/events')
  @HttpCode(HttpStatus.OK)
  event(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', `/${encodeURIComponent(sessionId)}/events`, request, response);
  }

  @Post(':sessionId/media-auth')
  @HttpCode(HttpStatus.OK)
  mediaAuth(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', `/${encodeURIComponent(sessionId)}/media-auth`, request, response);
  }

  private async forward(method: string, suffix: string, request: AuthenticatedRequest, response: Response, idempotent = false): Promise<void> {
    const session = request.authSession;
    if (!session?.active || !session.userId || !session.sessionId) throw new ServiceUnavailableException('Authenticated user session context is missing');
    const idempotencyKey = request.header('idempotency-key');
    if (idempotent && !idempotencyKey) {
      response.status(400).json(errorEnvelope({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key is required' }, request.requestId ?? 'unknown'));
      return;
    }
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.streamingUrl}/streaming/playback-sessions${suffix}`, {
        method, redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          'x-caller-service': 'api-gateway',
          'x-user-id': session.userId,
          'x-auth-session-id': session.sessionId,
          ...(session.role ? { 'x-user-role': session.role } : {}),
          'x-request-id': request.requestId ?? 'unknown',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      response.status(503).json(errorEnvelope({ code: 'STREAMING_UNAVAILABLE', message: 'Streaming service unavailable' }, request.requestId ?? 'unknown'));
      return;
    }
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    const cookies = upstream.headers.getSetCookie?.() ?? [];
    if (cookies.length) response.setHeader('set-cookie', cookies);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-request-id', request.requestId ?? 'unknown');
    response.status(upstream.status);
    if (upstream.status === 204) { response.end(); return; }
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }
}

@Controller('admin/videos')
@RequireRoles('admin', 'content_manager')
export class StreamingAdminProxyController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  initiate(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('/admin/videos/uploads', body, request, response); }

  @Post(':assetId/upload-complete')
  @HttpCode(HttpStatus.OK)
  complete(@Param('assetId', new ParseUUIDPipe()) assetId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward(`/admin/videos/${encodeURIComponent(assetId)}/upload-complete`, undefined, request, response); }

  private async forward(path: string, body: unknown, request: AuthenticatedRequest, response: Response): Promise<void> {
    const session = request.authSession;
    if (!session?.active || !session.userId || !session.sessionId || !session.role) throw new ServiceUnavailableException('Authenticated administrator context is missing');
    const idempotencyKey = request.header('idempotency-key');
    if (path.endsWith('/uploads') && !idempotencyKey) { response.status(400).json(errorEnvelope({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key is required' }, request.requestId ?? 'unknown')); return; }
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.streamingUrl}${path}`, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${this.config.serviceToken}`, 'x-caller-service': 'api-gateway', 'x-user-id': session.userId, 'x-auth-session-id': session.sessionId, 'x-user-role': session.role, 'x-request-id': request.requestId ?? 'unknown', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    } catch { response.status(503).json(errorEnvelope({ code: 'STREAMING_UNAVAILABLE', message: 'Streaming service unavailable' }, request.requestId ?? 'unknown')); return; }
    const contentType = upstream.headers.get('content-type'); if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-request-id', request.requestId ?? 'unknown'); response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  }
}
