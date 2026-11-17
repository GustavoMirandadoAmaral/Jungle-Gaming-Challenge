import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { persistenceEntities } from '../database/entities.js';
import { CreateWallet } from './application/create-wallet.js';
import { GetWallet } from './application/get-wallet.js';
import { WalletController } from './wallet.controller.js';

@Module({
  imports: [MikroOrmModule.forFeature(persistenceEntities)],
  controllers: [WalletController],
  providers: [{
    provide: CreateWallet,
    useFactory: (em: EntityManager) => new CreateWallet(em),
    inject: [EntityManager],
  }, {
    provide: GetWallet,
    useFactory: (em: EntityManager) => new GetWallet(em),
    inject: [EntityManager],
  }],
  exports: [],
})
export class WalletModule {}
