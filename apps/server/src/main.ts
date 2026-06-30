import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import {
  loadDevelopmentEnvFileIfPresent,
  loadServerEnvironment,
} from './config/environment';

async function bootstrap() {
  loadDevelopmentEnvFileIfPresent();
  const serverEnvironment = loadServerEnvironment();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableCors({
    origin: serverEnvironment.corsOrigins,
  });

  await app.listen(serverEnvironment.port, serverEnvironment.host);
}

void bootstrap();
