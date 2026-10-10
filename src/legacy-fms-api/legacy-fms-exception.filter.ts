import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  LEGACY_PERMISSION_DENIED,
  LegacyFmsException,
  legacyHttpStatus,
} from './legacy-fms.errors';

const INTERNAL_ERROR = 500;

@Catch()
export class LegacyFmsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(LegacyFmsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    if (
      exception instanceof UnauthorizedException ||
      exception instanceof ForbiddenException
    ) {
      response
        .status(403)
        .type('application/json')
        .send(LEGACY_PERMISSION_DENIED);
      return;
    }

    const { status, code, error } = describe(exception);
    this.logger.warn(
      `Legacy FMS API request failed: method=${request.method}, path=${request.path}, code=${code}, error=${error}`,
    );
    response.status(status).json({ code, error });
  }
}

function describe(exception: unknown): {
  status: number;
  code: number;
  error: string;
} {
  if (exception instanceof LegacyFmsException) {
    return {
      status: legacyHttpStatus(exception.code),
      code: exception.code,
      error: exception.message,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, code: status, error: exception.message };
  }
  const error =
    exception instanceof Error ? exception.message : String(exception);
  return { status: INTERNAL_ERROR, code: INTERNAL_ERROR, error };
}
