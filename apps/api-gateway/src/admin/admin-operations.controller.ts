import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { errorEnvelope, successEnvelope } from '@movie/shared-dto';
import { RequireRoles } from '../auth/role.guard';
import { AuthenticatedRequest } from '../auth/access-auth.guard';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { AdminUserSearchRateLimitGuard } from './admin-user-search-rate-limit.guard';

type Target = 'auth' | 'payment' | 'profile' | 'streaming';

@Controller('admin')
export class AdminOperationsController {
  private readonly logger = new Logger(AdminOperationsController.name);

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Get('overview')
  @RequireRoles('admin', 'content_manager', 'content_editor', 'support')
  async overview(@Req() request: AuthenticatedRequest) {
    const auth = await this.read('auth', '/admin/overview/auth', request);
    const payment = ['admin', 'support'].includes(request.authSession?.role ?? '') ? await this.read('payment', '/admin/overview/payment', request) : null;
    const streaming = request.authSession?.role === 'admin' ? await this.read('streaming', '/admin/playback-sessions/overview/streaming', request) : null;
    return successEnvelope({ ...auth, ...(payment ?? {}), ...(streaming ?? {}) }, request.requestId ?? 'unknown');
  }

  @Get('users') @RequireRoles('admin', 'support')
  @UseGuards(AdminUserSearchRateLimitGuard)
  users(@Query() _query: Record<string, string>, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'GET', request.originalUrl, undefined, request, response); }
  @Get('users/:userId') @RequireRoles('admin', 'support')
  user(@Param('userId', new ParseUUIDPipe()) _userId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'GET', request.originalUrl, undefined, request, response); }
  @Post('users/:userId/suspend') @RequireRoles('admin', 'support')
  suspend(@Param('userId', new ParseUUIDPipe()) _userId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'POST', request.originalUrl, body, request, response); }
  @Post('users/:userId/unsuspend') @RequireRoles('admin', 'support')
  unsuspend(@Param('userId', new ParseUUIDPipe()) _userId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'POST', request.originalUrl, body, request, response); }
  @Delete('users/:userId') @RequireRoles('admin') @HttpCode(HttpStatus.ACCEPTED)
  deleteUser(@Param('userId', new ParseUUIDPipe()) _userId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'DELETE', request.originalUrl, body, request, response); }
  @Get('users/:userId/sessions') @RequireRoles('admin', 'support')
  sessions(@Param('userId', new ParseUUIDPipe()) _userId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'GET', request.originalUrl, undefined, request, response); }
  @Get('users/:userId/profiles') @RequireRoles('admin', 'support')
  profiles(@Param('userId', new ParseUUIDPipe()) _userId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('profile', 'GET', request.originalUrl, undefined, request, response); }
  @Post('users/:userId/sessions/:sessionId/revoke') @RequireRoles('admin', 'support')
  revoke(@Param('userId', new ParseUUIDPipe()) _userId: string, @Param('sessionId', new ParseUUIDPipe()) _sessionId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'POST', request.originalUrl, body, request, response); }
  @Post('users/:userId/sessions/revoke-all') @RequireRoles('admin', 'support')
  revokeAll(@Param('userId', new ParseUUIDPipe()) _userId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'POST', request.originalUrl, body, request, response); }
  @Get('users/:userId/subscriptions') @RequireRoles('admin', 'support')
  subscriptions(@Param('userId', new ParseUUIDPipe()) _userId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('payment', 'GET', request.originalUrl, undefined, request, response); }
  @Post('users/:userId/subscriptions/extend') @RequireRoles('admin')
  extend(@Param('userId', new ParseUUIDPipe()) _userId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('payment', 'POST', request.originalUrl, body, request, response); }

  @Get('plans') @RequireRoles('admin')
  plans(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('payment', 'GET', request.originalUrl, undefined, request, response); }
  @Post('plans') @RequireRoles('admin') @HttpCode(HttpStatus.CREATED)
  createPlan(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('payment', 'POST', request.originalUrl, body, request, response); }
  @Patch('plans/:planId') @RequireRoles('admin')
  patchPlan(@Param('planId') _planId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('payment', 'PATCH', request.originalUrl, body, request, response); }
  @Get('transactions') @RequireRoles('admin', 'support')
  transactions(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('payment', 'GET', request.originalUrl, undefined, request, response); }

  @Get('playback-sessions') @RequireRoles('admin')
  playback(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('streaming', 'GET', request.originalUrl, undefined, request, response); }
  @Post('playback-sessions/:sessionId/terminate') @RequireRoles('admin')
  terminate(@Param('sessionId', new ParseUUIDPipe()) _sessionId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('streaming', 'POST', request.originalUrl, body, request, response); }

  @Get('audit-logs') @RequireRoles('admin', 'content_manager', 'support')
  logs(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'GET', request.originalUrl, undefined, request, response); }
  @Get('staff') @RequireRoles('admin')
  staff(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'GET', request.originalUrl, undefined, request, response); }
  @Post('staff') @RequireRoles('admin')
  createStaff(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'POST', request.originalUrl, body, request, response); }
  @Patch('staff/:staffId') @RequireRoles('admin')
  patchStaff(@Param('staffId', new ParseUUIDPipe()) _staffId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'PATCH', request.originalUrl, body, request, response); }
  @Delete('staff/:staffId') @RequireRoles('admin') @HttpCode(HttpStatus.NO_CONTENT)
  deleteStaff(@Param('staffId', new ParseUUIDPipe()) _staffId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('auth', 'DELETE', request.originalUrl, body, request, response); }

  private base(target: Target): string { return target === 'auth' ? this.config.authUrl : target === 'payment' ? this.config.paymentUrl : target === 'profile' ? this.config.profileUrl : this.config.streamingUrl; }

  private async read(target: Target, path: string, request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    let response: globalThis.Response;
    try {
      response = await this.request(target, 'GET', path, undefined, request);
    } catch (error) {
      this.logger.warn(`Admin overview dependency ${target} could not be reached for request ${request.requestId ?? 'unknown'}: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ServiceUnavailableException(`${target} overview is unavailable`);
    }
    if (!response.ok) {
      this.logger.warn(`Admin overview dependency ${target} returned HTTP ${response.status} for request ${request.requestId ?? 'unknown'}`);
      throw new ServiceUnavailableException(`${target} overview is unavailable`);
    }
    try {
      return ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
    } catch {
      this.logger.warn(`Admin overview dependency ${target} returned an invalid response for request ${request.requestId ?? 'unknown'}`);
      throw new ServiceUnavailableException(`${target} overview is invalid`);
    }
  }

  private async forward(target: Target, method: string, path: string, body: unknown, request: AuthenticatedRequest, response: Response): Promise<void> {
    const audit = this.auditAction(target, method, path, body);
    if (audit) this.requireReason(audit.reason);
    let upstream: globalThis.Response;
    try { upstream = await this.request(target, method, path, body, request); }
    catch { response.status(503).json(errorEnvelope({ code: `${target.toUpperCase()}_UNAVAILABLE`, message: `${target} service unavailable` }, request.requestId ?? 'unknown')); return; }
    const payload = upstream.status === 204 ? null : Buffer.from(await upstream.arrayBuffer());
    if (upstream.ok && audit) {
      if (audit.targetId === 'new' && payload) {
        try {
          const parsed = JSON.parse(payload.toString('utf8')) as { data?: { id?: unknown } };
          if (typeof parsed.data?.id === 'string' && parsed.data.id) audit.targetId = parsed.data.id;
        } catch { /* The request succeeded; use the stable creation marker if its response is not JSON. */ }
      }
      try {
        const auditResponse = await this.request('auth', 'POST', '/internal/auth/admin-audit', {
          actorId: request.authSession?.userId, action: audit.action, targetType: audit.targetType,
          targetId: audit.targetId, targetUserId: audit.targetUserId, reason: audit.reason,
          metadata: { service: target },
        }, request);
        if (!auditResponse.ok) throw new Error('Audit service rejected event');
      } catch {
        response.status(503).json(errorEnvelope({ code: 'ADMIN_AUDIT_UNAVAILABLE', message: 'The action completed but its audit record could not be saved; reload the affected page before retrying.' }, request.requestId ?? 'unknown'));
        return;
      }
    }
    const contentType = upstream.headers.get('content-type'); if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-request-id', request.requestId ?? 'unknown'); response.status(upstream.status);
    if (upstream.status === 204) { response.end(); return; }
    response.send(payload);
  }

  private request(target: Target, method: string, path: string, body: unknown, request: AuthenticatedRequest): Promise<globalThis.Response> {
    const session = request.authSession;
    if (!session?.active || !session.userId || !session.role) throw new ServiceUnavailableException('Authenticated administrator context is missing');
    return fetch(`${this.base(target)}${path}`, { method, redirect: 'manual', headers: { authorization: `Bearer ${this.config.serviceToken}`, 'x-caller-service': 'api-gateway', 'x-user-id': session.userId, 'x-user-role': session.role, 'x-request-id': request.requestId ?? 'unknown', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) });
  }

  private auditAction(target: Target, method: string, path: string, body: unknown): { action: string; targetType: string; targetId: string; targetUserId: string | null; reason: unknown } | null {
    const pathname = path.split('?')[0];
    const reason = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
    if (target === 'payment' && method === 'POST' && pathname === '/admin/plans') return { action: 'plan.created', targetType: 'plan', targetId: 'new', targetUserId: null, reason };
    const plan = /^\/admin\/plans\/([^/]+)$/.exec(pathname);
    if (target === 'payment' && method === 'PATCH' && plan) return { action: 'plan.updated', targetType: 'plan', targetId: plan[1], targetUserId: null, reason };
    const extension = /^\/admin\/users\/([0-9a-f-]{36})\/subscriptions\/extend$/i.exec(pathname);
    if (target === 'payment' && method === 'POST' && extension) return { action: 'subscription.extended', targetType: 'subscription', targetId: extension[1], targetUserId: extension[1], reason };
    const playback = /^\/admin\/playback-sessions\/([0-9a-f-]{36})\/terminate$/i.exec(pathname);
    if (target === 'streaming' && method === 'POST' && playback) return { action: 'playback_session.terminated', targetType: 'playback_session', targetId: playback[1], targetUserId: null, reason };
    return null;
  }

  private requireReason(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 1000) throw new BadRequestException('Reason must be 10 to 1000 characters');
  }
}
