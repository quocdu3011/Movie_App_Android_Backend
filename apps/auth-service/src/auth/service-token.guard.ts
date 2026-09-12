import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { constantTimeEquals, parseBearerToken } from '@movie/shared-auth';
import { AUTH_CONFIG, AuthConfig } from './auth.config';
import { Request } from 'express';

const allowedCallers = new Set([
  'api-gateway', 'profile-service', 'catalog-service', 'payment-service',
  'streaming-service', 'notification-service', 'recommendation-service',
]);

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = parseBearerToken(request.header('authorization'));
    if (!token) throw new UnauthorizedException('Service authentication required');
    const service = [...this.config.serviceTokens.entries()]
      .find(([, expected]) => constantTimeEquals(expected, token))?.[0];
    if (!service) throw new UnauthorizedException('Service authentication required');
    if (!allowedCallers.has(service)) throw new ForbiddenException('Caller is not allowed for this endpoint');
    (request as Request & { serviceName: string }).serviceName = service;
    return true;
  }
}
