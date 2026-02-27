import { SQSEvent } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import axios from 'axios';

const ses = new SESClient({ region: 'us-east-1' });

interface OrderEvent {
  orderId: string;
  customerId: string;
  productId: string;
  quantity: number;
  totalAmount: number;
  timestamp: string;
}

async function generateEmailContent(order: OrderEvent): Promise<{ subject: string; body: string }> {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a friendly e-commerce assistant. Write a short, warm order confirmation email. Respond ONLY with JSON: {"subject": "...", "body": "..."}. Keep body under 100 words.',
          },
          {
            role: 'user',
            content: `Write confirmation email for: Order #${order.orderId}, Product: ${order.productId}, Quantity: ${order.quantity}, Total: $${order.totalAmount}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 200,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  } catch (err) {
    // Fallback template if Groq fails
    return {
      subject: `Order Confirmation #${order.orderId}`,
      body: `Thank you for your order! Your order for ${order.quantity}x ${order.productId} ($${order.totalAmount}) has been received and is being processed.`,
    };
  }
}

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const snsMessage = JSON.parse(record.body);
    const order: OrderEvent = JSON.parse(snsMessage.Message);

    console.log('Sending notification for order:', order.orderId);

    // Generate personalized email via Groq
    const emailContent = await generateEmailContent(order);

    try {
      await ses.send(new SendEmailCommand({
        Source: process.env.SES_FROM_EMAIL!,
        Destination: {
          ToAddresses: [process.env.SES_FROM_EMAIL!], // in sandbox, can only send to verified emails
        },
        Message: {
          Subject: { Data: emailContent.subject },
          Body: {
            Text: { Data: emailContent.body },
          },
        },
      }));

      console.log('Notification sent for order:', order.orderId, '| Subject:', emailContent.subject);
    } catch (err) {
      console.error('SES send failed:', err);
      throw err; // let SQS retry
    }
  }
};