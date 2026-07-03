import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ModelsModule } from './model/models.module';
import { PluginsModule } from './plugins/plugins.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [ConfigModule, ModelsModule, PluginsModule, SessionsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
