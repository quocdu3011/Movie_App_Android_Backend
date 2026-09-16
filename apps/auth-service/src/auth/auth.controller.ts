import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { successEnvelope } from '@movie/shared-dto';
import { Request } from 'express';
import { AUTH_CONFIG, AuthConfig } from './auth.config';
import { Inject } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto, ValidateSessionDto } from './dto';
import { AdminServiceRequest, AuthAdminGuard, ServiceTokenGuard } from './service-token.guard';

interface RequestWithContext extends Request {
  requestId?: string;
  serviceName?: string;
}

function success<T>(data: T, request: RequestWithContext) {
  return successEnvelope(data, request.requestId ?? 'unknown');
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  @Post('register')
  @Header('Cache-Control', 'no-store')
  async register(@Body() body: RegisterDto, @Req() request: RequestWithContext) {
    const user = await this.auth.register(body);
    return success(user, request);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(@Body() body: LoginDto, @Req() request: RequestWithContext) {
    return success(await this.auth.login(body), request);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refresh(@Body() body: RefreshDto, @Req() request: RequestWithContext) {
    return success(await this.auth.refresh(body.refreshToken), request);
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: LogoutDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('.well-known/jwks.json')
  @Header('Cache-Control', 'public, max-age=600')
  jwks() {
    return this.config.publicJwks;
  }
}

@Controller('internal/auth')
@UseGuards(ServiceTokenGuard)
export class InternalAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('validate-session')
  async validateSession(@Body() body: ValidateSessionDto, @Req() request: RequestWithContext) {
    const session = await this.auth.validateSession(body.userId, body.sessionId);
    return success(session, request);
  }

  @Post('admin-audit')
  async adminAudit(@Body() body: { actorId?: string; action?: string; targetType?: string; targetId?: string; targetUserId?: string | null; reason?: string; metadata?: Record<string, unknown> }, @Req() request: RequestWithContext) {
    if (request.serviceName !== 'api-gateway' || !body.actorId || !body.action || !body.targetType || !body.targetId || !body.reason) throw new ForbiddenException('Gateway administrator audit context is required');
    await this.auth.recordExternalAudit(body.actorId, { action: body.action, targetType: body.targetType, targetId: body.targetId, targetUserId: body.targetUserId, reason: body.reason, requestId: request.requestId ?? 'unknown', metadata: body.metadata });
    return success({ recorded: true }, request);
  }
}

@Controller('admin')
@UseGuards(AuthAdminGuard)
export class AuthAdminController {
  constructor(private readonly auth: AuthService) {}

  @Get('users')
  async users(@Query() query: Record<string, string | undefined>, @Req() request: AdminServiceRequest) {
    return success(await this.auth.adminUsers({ page: optionalNumber(query.page), pageSize: optionalNumber(query.pageSize), status: query.status, email: query.email }), request);
  }

  @Get('users/:userId')
  async user(@Param('userId', new ParseUUIDPipe()) userId: string, @Req() request: AdminServiceRequest) { return success(await this.auth.adminUser(userId), request); }

  @Post('users/:userId/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(@Param('userId', new ParseUUIDPipe()) userId: string, @Body() body: { reason?: string }, @Req() request: AdminServiceRequest) {
    await this.auth.suspendUser(request.adminActorId!, userId, body.reason ?? '', request.requestId ?? 'unknown', true); return success({ userId, status: 'banned' }, request);
  }

  @Post('users/:userId/unsuspend')
  @HttpCode(HttpStatus.OK)
  async unsuspend(@Param('userId', new ParseUUIDPipe()) userId: string, @Body() body: { reason?: string }, @Req() request: AdminServiceRequest) {
    await this.auth.suspendUser(request.adminActorId!, userId, body.reason ?? '', request.requestId ?? 'unknown', false); return success({ userId, status: 'active' }, request);
  }

  @Delete('users/:userId')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteUser(@Param('userId', new ParseUUIDPipe()) userId: string, @Body() body: { reason?: string }, @Req() request: AdminServiceRequest) {
    await this.auth.deleteUser(request.adminActorId!, userId, body.reason ?? '', request.requestId ?? 'unknown'); return success({ userId, status: 'deleted' }, request);
  }

  @Get('users/:userId/sessions')
  async sessions(@Param('userId', new ParseUUIDPipe()) userId: string, @Req() request: AdminServiceRequest) { return success(await this.auth.adminSessions(userId), request); }

  @Post('users/:userId/sessions/:sessionId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeSession(@Param('userId', new ParseUUIDPipe()) userId: string, @Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Body() body: { reason?: string }, @Req() request: AdminServiceRequest) {
    await this.auth.revokeSession(request.adminActorId!, userId, sessionId, body.reason ?? '', request.requestId ?? 'unknown'); return success({ sessionId, revoked: true }, request);
  }

  @Post('users/:userId/sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  async revokeAll(@Param('userId', new ParseUUIDPipe()) userId: string, @Body() body: { reason?: string }, @Req() request: AdminServiceRequest) {
    await this.auth.revokeAllSessions(request.adminActorId!, userId, body.reason ?? '', request.requestId ?? 'unknown'); return success({ userId, revoked: true }, request);
  }

  @Get('staff')
  async staff(@Req() request: AdminServiceRequest) { this.adminOnly(request); return success(await this.auth.adminStaff(), request); }

  @Post('staff')
  async createStaff(@Body() body: { email?: string; role?: string; reason?: string }, @Req() request: AdminServiceRequest) {
    this.adminOnly(request); return success(await this.auth.promoteStaff(request.adminActorId!, body.email ?? '', body.role as never, body.reason ?? '', request.requestId ?? 'unknown'), request);
  }

  @Patch('staff/:staffId')
  async patchStaff(@Param('staffId', new ParseUUIDPipe()) staffId: string, @Body() body: { role?: string; reason?: string }, @Req() request: AdminServiceRequest) {
    this.adminOnly(request); await this.auth.changeStaffRole(request.adminActorId!, staffId, body.role as never, body.reason ?? '', request.requestId ?? 'unknown'); return success({ staffId, role: body.role }, request);
  }

  @Delete('staff/:staffId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteStaff(@Param('staffId', new ParseUUIDPipe()) staffId: string, @Body() body: { reason?: string }, @Req() request: AdminServiceRequest): Promise<void> {
    this.adminOnly(request); await this.auth.removeStaff(request.adminActorId!, staffId, body.reason ?? '', request.requestId ?? 'unknown');
  }

  @Get('audit-logs')
  async logs(@Query() query: Record<string, string | undefined>, @Req() request: AdminServiceRequest) {
    return success(await this.auth.auditLogs({ page: optionalNumber(query.page), pageSize: optionalNumber(query.pageSize), actorId: query.actorId, action: query.action, targetUserId: query.targetUserId, from: query.from, to: query.to }), request);
  }

  @Get('overview/auth')
  async metrics(@Req() request: AdminServiceRequest) { return success(await this.auth.adminMetrics(), request); }

  private adminOnly(request: AdminServiceRequest): void {
    if (request.adminRole !== 'admin') throw new ForbiddenException('Administrator role required');
  }
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

@Controller()
export class AuthHealthController {
  constructor(private readonly auth: AuthService) {}

  @Get('health')
  health(@Req() request: RequestWithContext) {
    return success({ status: 'ok', service: 'auth-service' }, request);
  }

  @Get('ready')
  async ready(@Req() request: RequestWithContext) {
    await this.auth.pingDatabase();
    return success({ status: 'ready', service: 'auth-service' }, request);
  }
}
