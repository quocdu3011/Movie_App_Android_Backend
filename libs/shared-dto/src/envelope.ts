import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  requestId: string;
}

export function successEnvelope<T>(data: T, requestId: string = randomUUID()): ApiEnvelope<T> {
  return { success: true, data, error: null, requestId };
}

export function errorEnvelope(error: ApiError, requestId: string = randomUUID()): ApiEnvelope<never> {
  return { success: false, data: null, error, requestId };
}

type RequestWithId = Request & { requestId?: string };

@Catch()
export class HttpExceptionEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const rawObject = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const message = typeof raw === 'string'
      ? raw
      : rawObject && 'message' in rawObject
        ? (Array.isArray(rawObject.message) ? rawObject.message.join(', ') : String(rawObject.message))
        : status >= 500 ? 'Internal server error' : 'Request failed';
    const providedCode = rawObject?.code;
    const code = typeof providedCode === 'string' && /^[A-Z][A-Z0-9_.-]{1,79}$/.test(providedCode)
      ? providedCode
      : status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`;
    const requestId = request.requestId ?? 'unknown';
    if (status >= 500) {
      console.error(JSON.stringify({ level: 'error', requestId, path: request.path, status }));
    }
    response.status(status).json(errorEnvelope({ code, message, ...(rawObject?.details === undefined ? {} : { details: rawObject.details }) }, requestId));
  }
}
