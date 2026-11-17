import { Injectable } from '@nestjs/common';

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

@Injectable()
export class AppMetrics {
  private readonly counters = new Map<string, MetricSample>();
  private readonly durationBuckets = new Map<number, number>(HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0]));
  private durationCount = 0;
  private durationSum = 0;
  private outboxLag = 0;
  private dlqMessages = 0;

  recordTransaction(status: string): void {
    this.increment('wager_transactions_total', { status });
  }

  recordIdempotencyReplay(): void {
    this.increment('idempotency_replays_total');
  }

  recordIdempotencyConflict(): void {
    this.increment('idempotency_conflicts_total');
  }

  recordInboxDuplicate(): void {
    this.increment('inbox_duplicates_total');
  }

  recordRetry(source: 'sqs' | 'outbox' | 'pending_reference'): void {
    this.increment('processing_retries_total', { source });
  }

  recordLockConflict(code: string): void {
    this.increment('database_lock_conflicts_total', { code });
  }

  observeWagerDuration(seconds: number): void {
    this.durationCount += 1;
    this.durationSum += seconds;
    for (const bucket of HISTOGRAM_BUCKETS) {
      if (seconds <= bucket) this.durationBuckets.set(bucket, (this.durationBuckets.get(bucket) ?? 0) + 1);
    }
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag = Math.max(seconds, 0);
  }

  setDlqMessages(count: number): void {
    this.dlqMessages = Math.max(count, 0);
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP wager_transactions_total Wager requests committed by terminal or pending status.',
      '# TYPE wager_transactions_total counter',
      ...this.renderSamples(this.counters, 'wager_transactions_total'),
      '# HELP idempotency_replays_total Requests served from a persistent idempotency record.',
      '# TYPE idempotency_replays_total counter',
      ...this.renderSamples(this.counters, 'idempotency_replays_total'),
      '# HELP idempotency_conflicts_total Reuse of an idempotency key with a different payload.',
      '# TYPE idempotency_conflicts_total counter',
      ...this.renderSamples(this.counters, 'idempotency_conflicts_total'),
      '# HELP inbox_duplicates_total SQS deliveries already recorded in the durable inbox.',
      '# TYPE inbox_duplicates_total counter',
      ...this.renderSamples(this.counters, 'inbox_duplicates_total'),
      '# HELP processing_retries_total Processing retries scheduled by source.',
      '# TYPE processing_retries_total counter',
      ...this.renderSamples(this.counters, 'processing_retries_total'),
      '# HELP database_lock_conflicts_total PostgreSQL serialization, deadlock, or lock-timeout conflicts.',
      '# TYPE database_lock_conflicts_total counter',
      ...this.renderSamples(this.counters, 'database_lock_conflicts_total'),
      '# HELP wager_processing_duration_seconds Wager use-case duration in seconds.',
      '# TYPE wager_processing_duration_seconds histogram',
      ...HISTOGRAM_BUCKETS.map((bucket) => `wager_processing_duration_seconds_bucket{le="${bucket}"} ${this.durationBuckets.get(bucket) ?? 0}`),
      `wager_processing_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`,
      `wager_processing_duration_seconds_sum ${this.durationSum}`,
      `wager_processing_duration_seconds_count ${this.durationCount}`,
      '# HELP outbox_lag_seconds Age of the oldest unpublished outbox event.',
      '# TYPE outbox_lag_seconds gauge',
      `outbox_lag_seconds ${this.outboxLag}`,
      '# HELP dead_letter_messages Number of visible and in-flight messages in the SQS dead-letter queue.',
      '# TYPE dead_letter_messages gauge',
      `dead_letter_messages ${this.dlqMessages}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  private increment(name: string, labels: Record<string, string> = {}): void {
    const key = `${name}:${JSON.stringify(labels)}`;
    const sample = this.counters.get(key);
    if (sample) sample.value += 1;
    else this.counters.set(key, { name, labels, value: 1 });
  }

  private renderSamples(samples: Map<string, MetricSample>, name: string): string[] {
    return [...samples.values()]
      .filter((sample) => sample.name === name)
      .map((sample) => {
        const labels = Object.entries(sample.labels)
          .map(([key, value]) => `${key}="${this.escapeLabel(value)}"`)
          .join(',');
        return `${name}${labels ? `{${labels}}` : ''} ${sample.value}`;
      });
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  }
}
