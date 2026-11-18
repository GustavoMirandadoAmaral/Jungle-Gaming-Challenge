#!/bin/bash
echo "Creating SQS FIFO queues..."

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo\\\",\\\"maxReceiveCount\\\":\\\"${SQS_WAGER_MAX_RECEIVE_COUNT:-5}\\\"}\"}"

awslocal sqs create-queue \
  --queue-name integration-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

echo "SQS queues created successfully!"
awslocal sqs list-queues
