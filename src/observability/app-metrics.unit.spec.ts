import { expect, test } from 'bun:test';
import { AppMetrics } from './app-metrics.js';

test('metrics render status, idempotency, retries, lock conflicts, latency, and dependency gauges', () => {
  const metrics = new AppMetrics();
  metrics.recordTransaction('PROCESSED');
  metrics.recordIdempotencyReplay();
  metrics.recordIdempotencyConflict();
  metrics.recordInboxDuplicate();
  metrics.recordRetry('sqs');
  metrics.recordLockConflict('40P01');
  metrics.observeWagerDuration(0.2);
  metrics.setOutboxLag(3.5);
  metrics.setDlqMessages(2);

  const output = metrics.renderPrometheus();
  expect(output).toContain('wager_transactions_total{status="PROCESSED"} 1');
  expect(output).toContain('idempotency_replays_total 1');
  expect(output).toContain('idempotency_conflicts_total 1');
  expect(output).toContain('inbox_duplicates_total 1');
  expect(output).toContain('processing_retries_total{source="sqs"} 1');
  expect(output).toContain('database_lock_conflicts_total{code="40P01"} 1');
  expect(output).toContain('wager_processing_duration_seconds_count 1');
  expect(output).toContain('outbox_lag_seconds 3.5');
  expect(output).toContain('dead_letter_messages 2');
});
