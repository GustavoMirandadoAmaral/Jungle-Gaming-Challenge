import { Controller, Get, Header } from '@nestjs/common';
import { AppMetrics } from './app-metrics.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: AppMetrics) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    return this.metrics.renderPrometheus();
  }
}
