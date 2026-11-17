import { v7 as uuidv7 } from 'uuid';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000; // 5 minutes

export interface OutboxMessageState {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: string;
  attempts: number;
  status: OutboxMessageStatus;
  scheduledAt: Date;
  publishedAt?: Date;
  createdAt: Date;
}

export enum OutboxMessageStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
}

export class OutboxMessage {
  private readonly _id: string;
  private readonly _eventType: string;
  private readonly _aggregateId: string;
  private readonly _payload: string;
  private _attempts: number;
  private _status: OutboxMessageStatus;
  private _scheduledAt: Date;
  private _publishedAt?: Date;
  private readonly _createdAt: Date;

  private constructor(
    id: string,
    eventType: string,
    aggregateId: string,
    payload: string,
    attempts: number,
    status: OutboxMessageStatus,
    scheduledAt: Date,
    createdAt: Date,
    publishedAt?: Date,
  ) {
    this._id = id;
    this._eventType = eventType;
    this._aggregateId = aggregateId;
    this._payload = payload;
    this._attempts = attempts;
    this._status = status;
    this._scheduledAt = scheduledAt;
    this._createdAt = createdAt;
    this._publishedAt = publishedAt;
  }

  static enqueue(params: {
    eventType: string;
    aggregateId: string;
    payload: string;
  }): OutboxMessage {
    const now = new Date();
    return new OutboxMessage(
      uuidv7(),
      params.eventType,
      params.aggregateId,
      params.payload,
      0,
      OutboxMessageStatus.Pending,
      now,
      now,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.eventType,
      state.aggregateId,
      state.payload,
      state.attempts,
      state.status,
      state.scheduledAt,
      state.createdAt,
      state.publishedAt,
    );
  }

  markPublished(): void {
    this._status = OutboxMessageStatus.Published;
    this._publishedAt = new Date();
    this._attempts += 1;
  }

  scheduleRetry(): void {
    this._attempts += 1;
    const backoffMs = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, this._attempts - 1),
      MAX_BACKOFF_MS,
    );
    this._scheduledAt = new Date(Date.now() + backoffMs);
  }

  isPending(): boolean {
    return this._status === OutboxMessageStatus.Pending;
  }

  isDue(): boolean {
    return this.isPending() && new Date() >= this._scheduledAt;
  }

  get id(): string {
    return this._id;
  }

  get eventType(): string {
    return this._eventType;
  }

  get aggregateId(): string {
    return this._aggregateId;
  }

  get payload(): string {
    return this._payload;
  }

  get attempts(): number {
    return this._attempts;
  }

  get status(): OutboxMessageStatus {
    return this._status;
  }

  get scheduledAt(): Date {
    return this._scheduledAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  toState(): OutboxMessageState {
    return {
      id: this._id,
      eventType: this._eventType,
      aggregateId: this._aggregateId,
      payload: this._payload,
      attempts: this._attempts,
      status: this._status,
      scheduledAt: this._scheduledAt,
      publishedAt: this._publishedAt,
      createdAt: this._createdAt,
    };
  }
}
