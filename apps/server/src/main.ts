import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import {
  loadServerDevelopmentEnvFiles,
  loadServerEnvironment,
} from './config/environment';
import { buildCorsOptions } from './config/cors';

async function bootstrap() {
  loadServerDevelopmentEnvFiles();
  const serverEnvironment = loadServerEnvironment();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableCors(buildCorsOptions(serverEnvironment.corsOrigins));

  await app.listen(serverEnvironment.port, serverEnvironment.host);
}

void bootstrap();
