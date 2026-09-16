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

export interface AdminServiceRequest extends Request {
  serviceName?: string;
  adminActorId?: string;
  adminRole?: string;
  requestId?: string;
}

@Injectable()
export class AuthAdminGuard implements CanActivate {
  constructor(private readonly serviceTokenGuard: ServiceTokenGuard) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.serviceTokenGuard.canActivate(context)) return false;
    const request = context.switchToHttp().getRequest<AdminServiceRequest>();
    if (request.serviceName !== 'api-gateway') throw new ForbiddenException('Admin routes are only available through the API Gateway');
    const actorId = request.header('x-user-id');
    const role = request.header('x-user-role');
    if (!actorId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId) || !role || !['admin', 'content_manager', 'content_editor', 'support'].includes(role)) {
      throw new ForbiddenException('Administrator context is required');
    }
    request.adminActorId = actorId;
    request.adminRole = role;
    return true;
  }
}
