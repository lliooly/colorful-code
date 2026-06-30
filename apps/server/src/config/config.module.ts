import { Global, Module } from '@nestjs/common';
import { loadServerEnvironment, type ServerEnvironment } from './environment';

// Injection token for the resolved, validated server environment. Provided once
// (a singleton) so any service can inject the same `ServerEnvironment` — notably
// the per-protocol provider API keys used to build model clients. The keys are
// secrets: they stay inside this value and must never be serialized into a
// SessionSnapshot, a log line, or an HTTP response.
export const SERVER_ENV = 'SERVER_ENV';

// A global module so `SERVER_ENV` is injectable everywhere without re-importing.
// `loadServerEnvironment()` runs once at provider construction; `main.ts` keeps
// its own load for host/port/cors during bootstrap (before the Nest container
// exists), and that is fine — both read the same already-loaded process env.
@Global()
@Module({
  providers: [
    {
      provide: SERVER_ENV,
      useFactory: (): ServerEnvironment => loadServerEnvironment()
    }
  ],
  exports: [SERVER_ENV]
})
export class ConfigModule {}
