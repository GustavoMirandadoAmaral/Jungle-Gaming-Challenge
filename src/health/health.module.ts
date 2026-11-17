import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [{
    provide: HealthService,
    useFactory: (em: EntityManager) => new HealthService(em),
    inject: [EntityManager],
  }],
  exports: [],
})
export class HealthModule {}
