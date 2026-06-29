import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  createPlaceholderModelClientFactory
} from './model-factory';

// The session transport: in-memory session registry (SessionsService) exposed
// over REST + SSE (SessionsController). The model client factory is a provider
// (token MODEL_CLIENT_FACTORY) so it can be overridden per environment — the
// default is a placeholder scripted mock until the real adapters (Step 2) land,
// and tests override it with their own scripted client.
@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    {
      provide: MODEL_CLIENT_FACTORY,
      useFactory: createPlaceholderModelClientFactory
    }
  ],
  exports: [SessionsService]
})
export class SessionsModule {}
