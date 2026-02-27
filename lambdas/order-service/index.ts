import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';
import axios from 'axios';

const ddb = new DynamoDBClient({});
const sns = new SNSClient({});

interface OrderRequest {
  customerId: string;
  productId: string;
  quantity: number;
  totalAmount: number;
}

// --- Groq Fraud Check ---
async function checkFraud(order: OrderRequest): Promise<{ isFraudulent: boolean; reason: string }> {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are a fraud detection system. Analyze orders and respond ONLY with valid JSON:
            {"isFraudulent": boolean, "reason": "brief explanation", "riskScore": number (0-100)}
            Flag as fraudulent if: quantity > 100, totalAmount > 10000, or amount/quantity ratio is abnormal.`,
          },
          {
            role: 'user',
            content: `Analyze this order: ${JSON.stringify(order)}`,
          },
        ],
        temperature: 0.1, // low temp for consistent fraud decisions
        max_tokens: 100,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000, // don't let fraud check block order for more than 5s
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  } catch (err) {
    // Fail open — if Groq is down, don't block orders
    console.warn('Fraud check failed, failing open:', err);
    return { isFraudulent: false, reason: 'fraud check unavailable' };
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body: OrderRequest = JSON.parse(event.body || '{}');

    // Basic validation
    if (!body.customerId || !body.productId || !body.quantity || !body.totalAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Fraud check via Groq
    const fraudResult = await checkFraud(body);
    if (fraudResult.isFraudulent) {
      console.warn('Fraudulent order detected:', fraudResult);
      return {
        statusCode: 422,
        body: JSON.stringify({ error: 'Order flagged for review', reason: fraudResult.reason }),
      };
    }

    const orderId = randomUUID();
    const timestamp = new Date().toISOString();

    // Save to DynamoDB — condition expression prevents duplicate orders
    await ddb.send(new PutItemCommand({
      TableName: process.env.ORDERS_TABLE!,
      Item: {
        orderId: { S: orderId },
        customerId: { S: body.customerId },
        productId: { S: body.productId },
        quantity: { N: body.quantity.toString() },
        totalAmount: { N: body.totalAmount.toString() },
        status: { S: 'PENDING' },
        createdAt: { S: timestamp },
      },
      ConditionExpression: 'attribute_not_exists(orderId)', // idempotency
    }));

    // Publish to SNS — fan-out to inventory + notifier
    await sns.send(new PublishCommand({
      TopicArn: process.env.ORDER_TOPIC_ARN!,
      Message: JSON.stringify({
        orderId,
        customerId: body.customerId,
        productId: body.productId,
        quantity: body.quantity,
        totalAmount: body.totalAmount,
        timestamp,
      }),
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: 'ORDER_CREATED',
        },
      },
    }));

    return {
      statusCode: 201,
      body: JSON.stringify({ orderId, status: 'PENDING', message: 'Order created successfully' }),
    };
  } catch (err: any) {
    console.error('Order creation failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};