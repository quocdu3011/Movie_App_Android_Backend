import 'reflect-metadata';
import 'dotenv/config';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { HttpExceptionEnvelopeFilter } from '@movie/shared-dto';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadStreamingConfig } from './streaming.config';

async function bootstrap(): Promise<void> {
  const config = loadStreamingConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
