import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { parseBearerToken } from '@movie/shared-auth';
import { Request } from 'express';
import { STREAMING_CONFIG, StreamingConfig, validStreamingToken } from './streaming.config';

export interface StreamingRequest extends Request {
  userId?: string;
  authSessionId?: string;
  userRole?: string;
  requestId?: string;
}

@Injectable()
export class StreamingGatewayGuard implements CanActivate {
  constructor(@Inject(STREAMING_CONFIG) private readonly config: StreamingConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<StreamingRequest>();
    const caller = request.header('x-caller-service') ?? undefined;
    const token = parseBearerToken(request.header('authorization') ?? undefined) ?? undefined;
    if (!validStreamingToken(token, caller, this.config)) throw new UnauthorizedException('Streaming API Gateway authentication required');
    if (caller !== 'api-gateway') throw new ForbiddenException('User playback routes are only available through the API Gateway');
    const userId = request.header('x-user-id');
    const authSessionId = request.header('x-auth-session-id');
    if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
      || !authSessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authSessionId)) {
      throw new UnauthorizedException('Trusted user session context is missing');
    }
    request.userId = userId;
    request.authSessionId = authSessionId;
    request.userRole = request.header('x-user-role') ?? undefined;
    return true;
  }
}

@Injectable()
export class StreamingAdminGuard implements CanActivate {
  constructor(@Inject(STREAMING_CONFIG) private readonly config: StreamingConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<StreamingRequest>();
    const caller = request.header('x-caller-service') ?? undefined;
    const token = parseBearerToken(request.header('authorization') ?? undefined) ?? undefined;
    if (!validStreamingToken(token, caller, this.config) || caller !== 'api-gateway') throw new UnauthorizedException('Streaming API Gateway authentication required');
    const role = request.header('x-user-role');
    const userId = request.header('x-user-id');
    if (!userId || !['admin', 'content_manager'].includes(role ?? '')) throw new ForbiddenException('Content administrator role required');
    request.userId = userId;
    request.userRole = role;
    return true;
  }
}

@Injectable()
export class StreamingWorkerGuard implements CanActivate {
  constructor(@Inject(STREAMING_CONFIG) private readonly config: StreamingConfig) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const caller = request.header('x-caller-service') ?? undefined;
    const token = parseBearerToken(request.header('authorization') ?? undefined) ?? undefined;
    if (!validStreamingToken(token, caller, this.config) || caller !== 'transcode-worker') throw new UnauthorizedException('Transcode worker authentication required');
    return true;
  }
}

@Injectable()
export class StreamingInternalGuard implements CanActivate {
  constructor(@Inject(STREAMING_CONFIG) private readonly config: StreamingConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const caller = request.header('x-caller-service') ?? undefined;
    const token = parseBearerToken(request.header('authorization') ?? undefined) ?? undefined;
    if (!validStreamingToken(token, caller, this.config)) throw new UnauthorizedException('Streaming service authentication required');
    if (caller !== 'profile-service') throw new ForbiddenException('Progress API is only available to Profile');
    return true;
  }
}
