import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { persistenceEntities } from '../database/entities.js';
import { ProcessWagerTransaction } from './application/process-wager-transaction.js';
import { WageringController } from './wagering.controller.js';
import { PendingReferenceExpirer } from './application/pending-reference-expirer.js';
import { GetWagerTransaction } from './application/get-wager-transaction.js';
import { ProviderWageringController } from './provider-wagering.controller.js';

@Module({
  imports: [MikroOrmModule.forFeature(persistenceEntities)],
  controllers: [WageringController, ProviderWageringController],
  providers: [{
    provide: ProcessWagerTransaction,
    useFactory: (em: EntityManager) => new ProcessWagerTransaction(em),
    inject: [EntityManager],
  }, {
    provide: PendingReferenceExpirer,
    useFactory: (em: EntityManager, processWager: ProcessWagerTransaction) => new PendingReferenceExpirer(em, processWager),
    inject: [EntityManager, ProcessWagerTransaction],
  }, {
    provide: GetWagerTransaction,
    useFactory: (em: EntityManager) => new GetWagerTransaction(em),
    inject: [EntityManager],
  }],
  exports: [ProcessWagerTransaction],
})
export class WageringModule {}
