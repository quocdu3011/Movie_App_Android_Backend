import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';

interface WindowEntry { count: number; resetAt: number }

@Injectable()
export class AdminUserSearchRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, WindowEntry>();

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (!request.query.email) return true;
    const response = http.getResponse<Response>();
    const now = Date.now();
    const actorId = (request as Request & { auth?: { userId?: string } }).auth?.userId;
    const key = `${actorId ?? request.ip}:admin-user-email-search`;
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + 60_000 };
    entry.count += 1;
    this.windows.set(key, entry);
    if (entry.count <= 20) return true;
    response.setHeader('retry-after', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    throw new HttpException('Too many user email searches', HttpStatus.TOO_MANY_REQUESTS);
  }
}
