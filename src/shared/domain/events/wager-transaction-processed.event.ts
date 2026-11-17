import { v7 as uuidv7 } from 'uuid';
import { MoneyProps } from '../value-objects/money.js';
import { IntegrationEvent, IntegrationEventProps } from './integration-event.js';

export interface WagerTransactionProcessedData {
  transactionId: string;
  externalTransactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  walletBalance: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(params: {
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    data: WagerTransactionProcessedData;
  }): WagerTransactionProcessedEvent {
    return new WagerTransactionProcessedEvent({
      eventId: uuidv7(),
      aggregateId: params.aggregateId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: new Date(),
      data: params.data,
    });
  }
}
