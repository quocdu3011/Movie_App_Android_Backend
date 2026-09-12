import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { HttpExceptionEnvelopeFilter } from '@movie/shared-dto';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { loadAuthConfig } from './auth/auth.config';

async function bootstrap(): Promise<void> {
  const config = loadAuthConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  app.enableShutdownHooks();
  await app.get(AuthService).seedAdmin();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
