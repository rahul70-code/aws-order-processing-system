import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { WorkerStack } from '../lib/worker-stack';

const app = new cdk.App();

const apiStack = new ApiStack(app, 'ApiStack');

// Pass tables into worker stack via props
new WorkerStack(app, 'WorkerStack', {
  ordersTable: apiStack.ordersTable,
  inventoryTable: apiStack.inventoryTable,
});