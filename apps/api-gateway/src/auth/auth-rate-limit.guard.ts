import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';

interface WindowEntry { count: number; resetAt: number }

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly rules: Record<string, { limit: number; ttlMs: number }> = {
    '/auth/register': { limit: 3, ttlMs: 60_000 },
    '/auth/login': { limit: 10, ttlMs: 60_000 },
    '/auth/refresh': { limit: 30, ttlMs: 60_000 },
  };

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const rule = this.rules[request.path];
    if (!rule) return true;
    const now = Date.now();
    const key = `${request.ip}:${request.path}`;
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + rule.ttlMs };
    entry.count += 1;
    this.windows.set(key, entry);
    if (this.windows.size > 10_000) {
      for (const [candidate, item] of this.windows) if (item.resetAt <= now) this.windows.delete(candidate);
    }
    if (entry.count > rule.limit) {
      response.setHeader('retry-after', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      throw new HttpException('Too many authentication requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
