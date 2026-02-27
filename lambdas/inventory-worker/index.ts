import { SQSEvent } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});

interface OrderEvent {
  orderId: string;
  customerId: string;
  productId: string;
  quantity: number;
  totalAmount: number;
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    // SNS wraps the message — need to unwrap
    const snsMessage = JSON.parse(record.body);
    const order: OrderEvent = JSON.parse(snsMessage.Message);

    console.log('Processing inventory for order:', order.orderId);

    try {
      // Check current stock first
      const currentStock = await ddb.send(new GetItemCommand({
        TableName: process.env.INVENTORY_TABLE!,
        Key: { productId: { S: order.productId } },
      }));

      const stock = parseInt(currentStock.Item?.stock?.N || '0');

      if (stock < order.quantity) {
        // Insufficient stock — update order status to FAILED
        await updateOrderStatus(order.orderId, 'FAILED_INSUFFICIENT_STOCK');
        console.warn(`Insufficient stock for product ${order.productId}. Stock: ${stock}, Required: ${order.quantity}`);
        continue;
      }

      // Decrement stock — condition expression prevents overselling
      await ddb.send(new UpdateItemCommand({
        TableName: process.env.INVENTORY_TABLE!,
        Key: { productId: { S: order.productId } },
        UpdateExpression: 'SET stock = stock - :qty',
        ConditionExpression: 'stock >= :qty', // atomic check — prevents race condition
        ExpressionAttributeValues: {
          ':qty': { N: order.quantity.toString() },
        },
      }));

      // Write back confirmed status to orders table
      await updateOrderStatus(order.orderId, 'CONFIRMED');
      console.log(`Order ${order.orderId} confirmed. Stock decremented by ${order.quantity}`);

    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Race condition — another Lambda took the last stock
        await updateOrderStatus(order.orderId, 'FAILED_INSUFFICIENT_STOCK');
        console.warn('Race condition — stock taken by concurrent order');
      } else {
        // Re-throw so SQS retries and eventually sends to DLQ
        throw err;
      }
    }
  }
};

async function updateOrderStatus(orderId: string, status: string): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: process.env.ORDERS_TABLE!,
    Key: { orderId: { S: orderId } },
    UpdateExpression: 'SET #s = :status, updatedAt = :ts',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: status },
      ':ts': { S: new Date().toISOString() },
    },
  }));
}