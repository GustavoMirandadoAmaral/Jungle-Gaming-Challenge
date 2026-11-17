import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { persistenceEntities } from '../database/entities.js';
import { ProcessWagerTransaction } from './application/process-wager-transaction.js';
import { WageringController } from './wagering.controller.js';

@Module({
  imports: [MikroOrmModule.forFeature(persistenceEntities)],
  controllers: [WageringController],
  providers: [{
    provide: ProcessWagerTransaction,
    useFactory: (em: EntityManager) => new ProcessWagerTransaction(em),
    inject: [EntityManager],
  }],
  exports: [ProcessWagerTransaction],
})
export class WageringModule {}
