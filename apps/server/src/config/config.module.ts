import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ServerEnvironment } from './environment';

// Injection token for the resolved, validated server environment. Provided once
// (a singleton) so any service can inject the same `ServerEnvironment` — notably
// the per-protocol provider API keys used to build model clients. The keys are
// secrets: they stay inside this value and must never be serialized into a
// SessionSnapshot, a log line, or an HTTP response.
export const SERVER_ENV = 'SERVER_ENV';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(environment: ServerEnvironment): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: SERVER_ENV, useValue: environment }],
      exports: [SERVER_ENV],
    };
  }
}
