#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { WorkerStack } from '../lib/worker-stack';

const app = new cdk.App();

const messagingStack = new MessagingStack(app, 'MessagingStack');

const apiStack = new ApiStack(app, 'ApiStack', {
  orderTopic: messagingStack.orderTopic,
  ordersTable: messagingStack.ordersTable,
  inventoryTable: messagingStack.inventoryTable,
});

new WorkerStack(app, 'WorkerStack', {
  inventoryQueue: messagingStack.inventoryQueue,
  notificationQueue: messagingStack.notificationQueue,
  ordersTable: messagingStack.ordersTable,
  inventoryTable: messagingStack.inventoryTable,
});