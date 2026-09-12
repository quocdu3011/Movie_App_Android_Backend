import 'reflect-metadata';
import 'dotenv/config';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { HttpExceptionEnvelopeFilter } from '@movie/shared-dto';
import { loadHttpServiceConfig } from '@movie/shared-config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = loadHttpServiceConfig('catalog-service', 'CATALOG_PORT', 3003);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
