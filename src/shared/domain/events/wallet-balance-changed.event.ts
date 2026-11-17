import { v7 as uuidv7 } from 'uuid';
import { LedgerDirection } from '../../../wallet/domain/enums/ledger-direction.enum.js';
import { MoneyProps } from '../value-objects/money.js';
import { IntegrationEvent, IntegrationEventProps } from './integration-event.js';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(params: {
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    data: WalletBalanceChangedData;
  }): WalletBalanceChangedEvent {
    return new WalletBalanceChangedEvent({
      eventId: uuidv7(),
      aggregateId: params.aggregateId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: new Date(),
      data: params.data,
    });
  }
}
