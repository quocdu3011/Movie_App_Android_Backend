import {
  CanActivate, ExecutionContext, Inject, Injectable, ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { parseBearerToken, verifyAccessToken, AccessTokenClaims, IS_PUBLIC_ROUTE } from '@movie/shared-auth';
import { Request } from 'express';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { JwksClient } from './jwks.client';

export interface ValidatedSession {
  active: boolean;
  userId: string;
  sessionId: string;
  role?: 'user' | 'admin' | 'content_manager' | 'content_editor' | 'support';
  email?: string;
  fullName?: string;
}

export interface AuthenticatedRequest extends Request {
  authClaims?: AccessTokenClaims;
  authSession?: ValidatedSession;
  requestId?: string;
}

@Injectable()
export class AccessAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwks: JwksClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.path === '/internal' || request.path.startsWith('/internal/')) {
      throw new UnauthorizedException();
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(), context.getClass(),
    ]);
    const profileScopedCatalog = request.path.startsWith('/catalog/') && request.path !== '/catalog/home' && Object.hasOwn(request.query, 'profileId');
    if (isPublic && !profileScopedCatalog) return true;
    const token = parseBearerToken(request.header('authorization'));
    if (!token) throw new UnauthorizedException('Authentication required');

    let keyId: string;
    try {
      const untrustedHeader = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { kid?: unknown };
      if (typeof untrustedHeader.kid !== 'string') throw new Error('JWT kid is missing');
      keyId = untrustedHeader.kid;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    let key;
    try {
      key = await this.jwks.getKey(keyId);
    } catch {
      throw new ServiceUnavailableException('Signing key service unavailable');
    }
    let claims: AccessTokenClaims;
    try {
      claims = verifyAccessToken(token, new Map([[keyId, key]]), {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${this.config.authUrl}/internal/auth/validate-session`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          'content-type': 'application/json',
          'x-request-id': request.requestId ?? 'unknown',
        },
        body: JSON.stringify({ userId: claims.sub, sessionId: claims.sid }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      throw new ServiceUnavailableException('Authentication service unavailable');
    }
    if (!upstream.ok) throw new ServiceUnavailableException('Authentication service unavailable');
    let envelope: { data?: ValidatedSession };
    try {
      envelope = await upstream.json() as { data?: ValidatedSession };
    } catch {
      throw new ServiceUnavailableException('Authentication service returned an invalid response');
    }
    const session = envelope.data;
    if (!session?.active || session.userId !== claims.sub || session.sessionId !== claims.sid) {
      throw new UnauthorizedException('Authentication session is no longer active');
    }
    request.authClaims = claims;
    request.authSession = session;
    return true;
  }
}
