import { v7 as uuidv7 } from 'uuid';
import { MoneyProps } from '../value-objects/money.js';
import { IntegrationEvent, IntegrationEventProps } from './integration-event.js';

export interface WagerTransactionRejectedData {
  transactionId: string;
  externalTransactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(params: {
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    data: WagerTransactionRejectedData;
  }): WagerTransactionRejectedEvent {
    return new WagerTransactionRejectedEvent({
      eventId: uuidv7(),
      aggregateId: params.aggregateId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: new Date(),
      data: params.data,
    });
  }
}
