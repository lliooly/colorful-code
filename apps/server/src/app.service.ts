import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@colorful-code/schema';
import {
  createBuiltinTools,
  describeTools
} from '@colorful-code/tool-runtime';

@Injectable()
export class AppService {
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }

  // Step 0 proof-of-consumption: imports runnable JS from
  // @colorful-code/tool-runtime at runtime and exercises it.
  getToolsHealth(): { status: 'ok'; count: number; names: string[] } {
    const descriptors = describeTools(createBuiltinTools());
    return {
      status: 'ok',
      count: descriptors.length,
      names: descriptors.map((descriptor) => descriptor.name)
    };
  }
}
