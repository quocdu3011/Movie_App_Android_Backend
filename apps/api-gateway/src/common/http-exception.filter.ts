import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const message = typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && 'message' in raw
        ? (Array.isArray(raw.message) ? raw.message.join(', ') : String(raw.message))
        : status >= 500 ? 'Internal server error' : 'Request failed';
    if (status >= 500) {
      console.error(JSON.stringify({ level: 'error', requestId: request.requestId, path: request.path, status }));
    }
    response.status(status).json({
      success: false,
      data: null,
      error: { code: status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`, message },
      requestId: request.requestId ?? 'unknown',
    });
  }
}
