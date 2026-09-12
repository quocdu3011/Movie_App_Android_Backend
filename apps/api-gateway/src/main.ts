import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { HttpExceptionEnvelopeFilter } from '@movie/shared-dto';
import { AppModule } from './app.module';
import { loadGatewayConfig } from './gateway.config';

async function bootstrap(): Promise<void> {
  const config = loadGatewayConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.use(helmet());
  app.enableCors({ origin: config.origins, credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
