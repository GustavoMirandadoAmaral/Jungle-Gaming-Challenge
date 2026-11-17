import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { persistenceEntities } from '../database/entities.js';
import { ProcessWagerTransaction } from './application/process-wager-transaction.js';
import { WageringController } from './wagering.controller.js';
import { PendingReferenceExpirer } from './application/pending-reference-expirer.js';
import { GetWagerTransaction } from './application/get-wager-transaction.js';
import { ProviderWageringController } from './provider-wagering.controller.js';
import { AppMetrics } from '../observability/app-metrics.js';
import { ProviderIdentityPort } from './application/provider-identity.port.js';
import { NoopProviderIdentity } from './application/noop-provider-identity.js';

@Module({
  imports: [MikroOrmModule.forFeature(persistenceEntities)],
  controllers: [WageringController, ProviderWageringController],
  providers: [{
    provide: ProviderIdentityPort,
    useClass: NoopProviderIdentity,
  }, {
    provide: ProcessWagerTransaction,
    useFactory: (em: EntityManager, metrics: AppMetrics) => new ProcessWagerTransaction(em, metrics),
    inject: [EntityManager, AppMetrics],
  }, {
    provide: PendingReferenceExpirer,
    useFactory: (em: EntityManager, processWager: ProcessWagerTransaction, metrics: AppMetrics) => new PendingReferenceExpirer(em, processWager, metrics),
    inject: [EntityManager, ProcessWagerTransaction, AppMetrics],
  }, {
    provide: GetWagerTransaction,
    useFactory: (em: EntityManager) => new GetWagerTransaction(em),
    inject: [EntityManager],
  }],
  exports: [ProcessWagerTransaction],
})
export class WageringModule {}
