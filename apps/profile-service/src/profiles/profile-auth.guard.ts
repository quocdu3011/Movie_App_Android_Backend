import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { constantTimeEquals, parseBearerToken } from '@movie/shared-auth';
import { ProfileConfig, PROFILE_CONFIG } from '../profile.config';
import { Inject } from '@nestjs/common';

interface ProfileRequest extends Request {
  serviceName?: string;
  requestId?: string;
}

const INTERNAL_CALLERS = new Set(['api-gateway', 'streaming-service', 'catalog-service', 'recommendation-service']);

function authenticate(request: ProfileRequest, config: ProfileConfig): string {
  const token = parseBearerToken(request.header('authorization'));
  if (!token) throw new UnauthorizedException('Service authentication required');
  const caller = [...config.serviceTokens.entries()]
    .find(([, expected]) => constantTimeEquals(expected, token))?.[0];
  if (!caller) throw new UnauthorizedException('Service authentication required');
  request.serviceName = caller;
  return caller;
}

@Injectable()
export class ProfileGatewayGuard implements CanActivate {
  constructor(@Inject(PROFILE_CONFIG) private readonly config: ProfileConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ProfileRequest>();
    if (authenticate(request, this.config) !== 'api-gateway') {
      throw new ForbiddenException('Profile user routes are only available through the API Gateway');
    }
    return true;
  }
}

@Injectable()
export class ProfileInternalGuard implements CanActivate {
  constructor(@Inject(PROFILE_CONFIG) private readonly config: ProfileConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ProfileRequest>();
    if (!INTERNAL_CALLERS.has(authenticate(request, this.config))) {
      throw new ForbiddenException('Caller is not allowed to validate profiles');
    }
    return true;
  }
}

@Injectable()
export class ProfileAdminGuard implements CanActivate {
  constructor(@Inject(PROFILE_CONFIG) private readonly config: ProfileConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ProfileRequest>();
    if (authenticate(request, this.config) !== 'api-gateway') throw new ForbiddenException('Profile administrator routes are only available through the API Gateway');
    if (!['admin', 'support'].includes(request.header('x-user-role') ?? '')) throw new ForbiddenException('Profile administrator role required');
    return true;
  }
}
