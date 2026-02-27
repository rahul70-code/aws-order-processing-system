import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda_events from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

interface WorkerStackProps extends cdk.StackProps {
  inventoryQueue: sqs.Queue;
  notificationQueue: sqs.Queue;
  ordersTable: dynamodb.Table;
  inventoryTable: dynamodb.Table;
}

export class WorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    // Inventory Lambda
    const inventoryLambda = new lambda_nodejs.NodejsFunction(this, 'InventoryLambda', {
      entry: path.join(__dirname, '../lambdas/inventory-worker/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        INVENTORY_TABLE: props.inventoryTable.tableName,
        ORDERS_TABLE: props.ordersTable.tableName,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    inventoryLambda.addEventSource(new lambda_events.SqsEventSource(props.inventoryQueue, {
      batchSize: 1, // process one order at a time for inventory accuracy
    }));

    props.inventoryTable.grantReadWriteData(inventoryLambda);
    props.ordersTable.grantReadWriteData(inventoryLambda); // to write back status

    // Notifier Lambda
    const notifierLambda = new lambda_nodejs.NodejsFunction(this, 'NotifierLambda', {
      entry: path.join(__dirname, '../lambdas/notifier-worker/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        GROQ_API_KEY: process.env.GROQ_API_KEY || '', // passed from SSM at deploy time
        SES_FROM_EMAIL: 'you@gmail.com', // your verified SES email
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    notifierLambda.addEventSource(new lambda_events.SqsEventSource(props.notificationQueue, {
      batchSize: 5,
    }));

    // SES permission
    notifierLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));
  }
}