import { Controller, Get, HttpCode, HttpStatus, Post, Body, Req, Res, UseGuards, Inject } from '@nestjs/common';
import { Request, Response } from 'express';
import { ServiceUnavailableException } from '@nestjs/common';
import { PublicRoute } from '@movie/shared-auth';
import { errorEnvelope, successEnvelope } from '@movie/shared-dto';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { AuthenticatedRequest } from './access-auth.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { RequireRoles } from './role.guard';

@Controller('auth')
@PublicRoute()
export class AuthProxyController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Post('register')
  @UseGuards(AuthRateLimitGuard)
  register(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '/auth/register', body, request, response);
  }

  @Post('login')
  @UseGuards(AuthRateLimitGuard)
  login(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '/auth/login', body, request, response);
  }

  @Post('refresh')
  @UseGuards(AuthRateLimitGuard)
  refresh(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '/auth/refresh', body, request, response);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '/auth/logout', body, request, response);
  }

  @Get('.well-known/jwks.json')
  async jwks(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', '/auth/.well-known/jwks.json', undefined, request, response);
  }

  private async forward(
    method: string,
    path: string,
    body: unknown,
    request: Request & { requestId?: string },
    response: Response,
  ): Promise<void> {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.authUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-request-id': request.requestId ?? 'unknown',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      response.status(503).json(errorEnvelope(
        { code: 'AUTH_UNAVAILABLE', message: 'Authentication service unavailable' },
        request.requestId ?? 'unknown',
      ));
      return;
    }
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('cache-control', path.endsWith('jwks.json') ? 'public, max-age=600' : 'no-store');
    response.setHeader('x-request-id', request.requestId ?? 'unknown');
    response.status(upstream.status);
    if (upstream.status === 204) {
      response.end();
      return;
    }
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }
}

@Controller('auth')
export class SessionController {
  @Get('session')
  current(@Req() request: AuthenticatedRequest) {
    const session = request.authSession;
    return successEnvelope(session, request.requestId ?? 'unknown');
  }
}

@Controller()
export class GatewayHealthController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Get('health')
  @PublicRoute()
  health(@Req() request: AuthenticatedRequest) {
    return successEnvelope({ status: 'ok', service: 'api-gateway' }, request.requestId ?? 'unknown');
  }

  @Get('ready')
  @PublicRoute()
  async ready(@Req() request: AuthenticatedRequest) {
    try {
      const result = await fetch(`${this.config.authUrl}/ready`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });
      if (!result.ok) throw new Error('Auth is not ready');
    } catch {
      throw new ServiceUnavailableException('Authentication service is not ready');
    }
    return successEnvelope({ status: 'ready', service: 'api-gateway' }, request.requestId ?? 'unknown');
  }
}

@Controller('admin')
export class AdminSessionController {
  @Get('session')
  @RequireRoles('admin', 'content_manager', 'content_editor', 'support')
  current(@Req() request: AuthenticatedRequest) {
    return successEnvelope(request.authSession, request.requestId ?? 'unknown');
  }
}
