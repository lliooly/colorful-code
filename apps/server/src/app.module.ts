import { Module, type DynamicModule } from '@nestjs/common';
import type { ServerEnvironment } from './config/environment';
import { ConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ModelsModule } from './model/models.module';
import { PluginsModule } from './plugins/plugins.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({})
export class AppModule {
  static forRoot(environment: ServerEnvironment): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(environment),
        ModelsModule,
        PluginsModule,
        SessionsModule,
      ],
      controllers: [AppController],
      providers: [AppService],
    };
  }
}
