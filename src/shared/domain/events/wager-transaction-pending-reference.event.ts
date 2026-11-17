import { v7 as uuidv7 } from 'uuid';
import { IntegrationEvent, IntegrationEventProps } from './integration-event.js';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  externalTransactionId: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(params: {
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    data: WagerTransactionPendingReferenceData;
  }): WagerTransactionPendingReferenceEvent {
    return new WagerTransactionPendingReferenceEvent({
      eventId: uuidv7(),
      aggregateId: params.aggregateId,
      correlationId: params.correlationId,
      causationId: params.causationId,
      occurredAt: new Date(),
      data: params.data,
    });
  }
}
