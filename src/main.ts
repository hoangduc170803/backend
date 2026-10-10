import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { setupApiDocs } from './api-docs/api-docs';
import { createWesLogger } from './logging/winston.config';
import { holdSingleInstanceLock } from './single-instance.lock';

async function bootstrap() {
  const instanceLock = await holdSingleInstanceLock();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  process.once('exit', () => void instanceLock?.destroy());
  app.useLogger(createWesLogger());

  app.setGlobalPrefix('api', { exclude: ['/', 'transport-order'] });

  app.use(cookieParser());

  const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  setupApiDocs(app);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
