import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [ConfigModule, SessionsModule],
  controllers: [AppController],
  providers: [AppService]
})
export class AppModule {}
