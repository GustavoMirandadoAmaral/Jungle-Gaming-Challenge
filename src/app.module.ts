import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ScheduleModule } from '@nestjs/schedule';
import mikroOrmConfig from './mikro-orm.config';
import { WalletModule } from './wallet/wallet.module';
import { WageringModule } from './wagering/wagering.module';
import { MessagingModule } from './messaging/messaging.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ScheduleModule.forRoot(),
    WalletModule,
    WageringModule,
    MessagingModule,
    HealthModule,
  ],
})
export class AppModule {}
