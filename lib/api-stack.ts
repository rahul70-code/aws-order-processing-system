import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

interface ApiStackProps extends cdk.StackProps {
  orderTopic: sns.Topic;
  ordersTable: dynamodb.Table;
  inventoryTable: dynamodb.Table;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Read Groq API key from SSM (store it manually once — see setup below)
    const groqApiKey = ssm.StringParameter.valueForStringParameter(
      this, '/order-system/groq-api-key'
    );

    // Order Lambda
    const orderLambda = new lambda_nodejs.NodejsFunction(this, 'OrderLambda', {
      entry: path.join(__dirname, '../lambdas/order-service/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ORDERS_TABLE: props.ordersTable.tableName,
        ORDER_TOPIC_ARN: props.orderTopic.topicArn,
        GROQ_API_KEY: groqApiKey,
      },
      tracing: lambda.Tracing.ACTIVE, // X-Ray
    });

    // IAM — least privilege
    props.ordersTable.grantReadWriteData(orderLambda);
    props.orderTopic.grantPublish(orderLambda);

    // API Gateway
    const api = new apigateway.RestApi(this, 'OrderApi', {
      restApiName: 'Order Service',
      deployOptions: {
        tracingEnabled: true, // X-Ray on API GW too
      },
    });

    const orders = api.root.addResource('orders');
    orders.addMethod('POST', new apigateway.LambdaIntegration(orderLambda));

    // Output the API URL
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });
  }
}