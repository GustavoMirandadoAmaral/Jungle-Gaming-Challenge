import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Process liveness only: this should not fail just because a dependency is down. */
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /** Readiness means this instance can currently reach its required dependencies. */
  @Get('ready')
  async ready() {
    const state = await this.health.checkDependencies();
    if (state.status !== 'ready') {
      throw new ServiceUnavailableException(state);
    }
    return state;
  }
}
