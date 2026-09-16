import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { AuthenticatedRequest } from './access-auth.guard';

export const REQUIRED_ROLES = 'requiredRoles';
export const RequireRoles = (...roles: Array<'user' | 'admin' | 'content_manager' | 'content_editor' | 'support'>) => SetMetadata(REQUIRED_ROLES, roles);

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isAdminRoute = /^\/admin(?:\/|$)/.test(request.path);
    if (!isAdminRoute) return true;
    const required = this.reflector.getAllAndOverride<Array<'user' | 'admin' | 'content_manager' | 'content_editor' | 'support'>>(REQUIRED_ROLES, [
      context.getHandler(), context.getClass(),
    ]) ?? ['admin'];
    if (!request.authSession?.role || !required.includes(request.authSession.role)) {
      throw new ForbiddenException('Administrator role required');
    }
    return true;
  }
}
