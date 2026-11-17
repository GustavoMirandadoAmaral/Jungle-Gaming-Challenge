import { Global, Module } from '@nestjs/common';
import { AppMetrics } from './app-metrics.js';
import { MetricsController } from './metrics.controller.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [AppMetrics],
  exports: [AppMetrics],
})
export class ObservabilityModule {}
