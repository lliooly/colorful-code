import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@colorful-code/schema';

@Injectable()
export class AppService {
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
