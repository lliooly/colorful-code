import { Module } from '@nestjs/common';
import { SERVER_ENV } from '../config/config.module';
import type { ServerEnvironment } from '../config/environment';
import { PersistenceModule } from '../persistence/persistence.module';
import { PluginsModule } from '../plugins/plugins.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  createServerModelClientFactory,
} from './model-factory';
import { VoiceTranscriptionService } from './voice-transcription';

// The session transport: in-memory session registry (SessionsService) exposed
// over REST + SSE (SessionsController). The model client factory is a provider
// (token MODEL_CLIENT_FACTORY) so it can be overridden per environment — the
// default is the real per-protocol adapter factory (built from the injected
// ServerEnvironment provider keys), and tests override it with their own
// scripted client.
@Module({
  imports: [PersistenceModule, PluginsModule],
  controllers: [SessionsController],
  providers: [
    SessionsService,
    VoiceTranscriptionService,
    {
      provide: MODEL_CLIENT_FACTORY,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnvironment) =>
        createServerModelClientFactory(env),
    },
  ],
  exports: [SessionsService],
})
export class SessionsModule {}
