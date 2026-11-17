import { v7 as uuidv7 } from 'uuid';

export interface InboxMessageState {
  id: string;
  messageId: string;
  queueName: string;
  payload: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private readonly _id: string;
  private readonly _messageId: string;
  private readonly _queueName: string;
  private readonly _payload: string;
  private readonly _receivedAt: Date;
  private _processedAt?: Date;

  private constructor(
    id: string,
    messageId: string,
    queueName: string,
    payload: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this._id = id;
    this._messageId = messageId;
    this._queueName = queueName;
    this._payload = payload;
    this._receivedAt = receivedAt;
    this._processedAt = processedAt;
  }

  static receive(params: {
    messageId: string;
    queueName: string;
    payload: string;
  }): InboxMessage {
    return new InboxMessage(
      uuidv7(),
      params.messageId,
      params.queueName,
      params.payload,
      new Date(),
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.id,
      state.messageId,
      state.queueName,
      state.payload,
      state.receivedAt,
      state.processedAt,
    );
  }

  markProcessed(at: Date): void {
    this._processedAt = at;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  get id(): string {
    return this._id;
  }

  get messageId(): string {
    return this._messageId;
  }

  get queueName(): string {
    return this._queueName;
  }

  get payload(): string {
    return this._payload;
  }

  get receivedAt(): Date {
    return this._receivedAt;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  toState(): InboxMessageState {
    return {
      id: this._id,
      messageId: this._messageId,
      queueName: this._queueName,
      payload: this._payload,
      receivedAt: this._receivedAt,
      processedAt: this._processedAt,
    };
  }
}
