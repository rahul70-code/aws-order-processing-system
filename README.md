# ⚡ Event-Driven Order Processing System

> **Microservices · AI Fraud Detection · Serverless · Free Tier · AWS CDK**

```
Client → API Gateway → Order Lambda → [Groq AI Fraud Check] → DynamoDB
                                              ↓
                                       SNS Topic (fan-out)
                                      ↙              ↘
                              SQS: inventory    SQS: notification
                                   ↓                   ↓
                          Inventory Lambda      Notifier Lambda
                          (atomic stock         (Groq email gen
                           decrement)            → SES delivery)
```

---

## What Is This?

A production-grade event-driven order pipeline built entirely on AWS free tier. When a customer places an order:

1. **AI scores it for fraud** via Groq (Llama 3.3 70B) — suspicious orders are rejected before touching the database
2. **Order is saved** to DynamoDB with an idempotency guard — safe to retry
3. **SNS fans out** a single event to two independent consumers simultaneously
4. **Inventory is decremented atomically** — a single condition expression prevents overselling under concurrent load
5. **A personalized email is generated** by Groq and delivered via SES

Everything downstream of SNS is async. The customer gets a response in ~200ms.

---

## Stack

| Layer | Service | Why |
|---|---|---|
| Entry point | API Gateway | Managed, zero-idle-cost |
| Compute | Lambda (Node.js 20) | Scales to zero, pay-per-invocation |
| Database | DynamoDB (PAY_PER_REQUEST) | No connection pool issues with Lambda, atomic condition expressions |
| Messaging | SNS + SQS | Fan-out pattern, built-in retry, DLQ support |
| AI | Groq API (Llama 3.3 70B) | Free tier, fast inference, OpenAI-compatible |
| Email | SES | AWS-native, one SDK call |
| Secrets | SSM Parameter Store | Encrypted, never in code |
| Tracing | X-Ray | One line in CDK, traces across all Lambdas |
| IaC | AWS CDK (TypeScript) | Type-safe, cross-stack refs, auto IAM |

**Total cost: $0** — everything runs within AWS free tier limits.

---

## Project Structure

```
order-system/
├── bin/
│   └── app.ts                  # CDK entry — stack instantiation order
├── lib/
│   ├── messaging-stack.ts      # DynamoDB + SNS + SQS + DLQs + Alarms
│   ├── api-stack.ts            # API Gateway + Order Lambda
│   └── worker-stack.ts         # Inventory Lambda + Notifier Lambda
├── lambdas/
│   ├── order-service/
│   │   └── index.ts            # Fraud check → DDB write → SNS publish
│   ├── inventory-worker/
│   │   └── index.ts            # Atomic stock decrement + status writeback
│   └── notifier-worker/
│       └── index.ts            # Groq email generation → SES send
├── scripts/
│   └── seed-inventory.ts       # Seed DDB inventory table for testing
└── cdk.json
```

### Stack Dependency Order

```
MessagingStack          (no deps — deployed first)
    ↓
ApiStack                (needs SNS ARN, table names from Messaging)
    ↓
WorkerStack             (needs queue refs, table refs from Messaging)
```

---

## Prerequisites

```bash
# Tools
npm install -g aws-cdk typescript
aws configure   # needs AWS credentials

# One-time: verify your email in SES (takes ~1 min)
aws ses verify-email-identity \
  --email-address you@gmail.com \
  --region us-east-1

# One-time: store Groq API key in SSM
# Get free key at: https://console.groq.com
aws ssm put-parameter \
  --name "/order-system/groq-api-key" \
  --value "YOUR_GROQ_KEY" \
  --type SecureString \
  --region us-east-1
```

---

## Getting Started

```bash
# Clone and install
git clone <repo>
cd order-system
npm install

# Bootstrap CDK (one-time per AWS account/region)
cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1

# Deploy all stacks
cdk deploy --all

# Seed inventory data
npx ts-node scripts/seed-inventory.ts
```

The deploy output will print your API Gateway URL.

---

## Testing

### Happy Path
```bash
curl -X POST https://YOUR_API_URL/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-123",
    "productId": "PROD-001",
    "quantity": 2,
    "totalAmount": 1998
  }'

# → 201 { orderId: "...", status: "PENDING" }
# → Check DDB: status becomes CONFIRMED
# → Check inbox: personalized email arrives
```

### Fraud Trigger
```bash
curl -X POST https://YOUR_API_URL/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-456",
    "productId": "PROD-001",
    "quantity": 500,
    "totalAmount": 499000
  }'

# → 422 { error: "Order flagged for review" }
# → Nothing written to DDB
```

### Insufficient Stock (PROD-003 seeded with 5 units)
```bash
curl -X POST https://YOUR_API_URL/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-789",
    "productId": "PROD-003",
    "quantity": 10,
    "totalAmount": 790
  }'

# → 201 accepted
# → DDB order status → FAILED_INSUFFICIENT_STOCK after Inventory Lambda runs
```

### DLQ Test
```bash
# Break Inventory Lambda (set a bad env var), place an order.
# Watch CloudWatch Logs: 3 retries, then message lands in DLQ.
# CloudWatch alarm transitions to ALARM state.
# Fix the Lambda, redrive from DLQ.
```

### Check Order Status
```bash
aws dynamodb get-item \
  --table-name orders \
  --key '{"orderId": {"S": "YOUR_ORDER_ID"}}'
```

---

## Key Patterns

### Idempotency — Duplicate Order Prevention
```typescript
// Order Lambda — DDB PutItem
ConditionExpression: 'attribute_not_exists(orderId)'
// If API Gateway retries on timeout, the second call silently fails — no duplicate order
```

### Atomic Stock Decrement — Prevents Overselling
```typescript
// Inventory Lambda — DDB UpdateItem
UpdateExpression: 'SET stock = stock - :qty',
ConditionExpression: 'stock >= :qty'
// Two Lambdas running concurrently — DynamoDB guarantees only one wins
// Loser gets ConditionalCheckFailedException → order status = FAILED_INSUFFICIENT_STOCK
```

### Fail-Open AI
```typescript
// If Groq is down, fail open — never block orders because AI is unavailable
catch (err) {
  console.warn('Fraud check failed, failing open');
  return { isFraudulent: false, reason: 'fraud check unavailable' };
}
```

### SQS Visibility Timeout = 6x Lambda Timeout
```typescript
// messaging-stack.ts
visibilityTimeout: cdk.Duration.seconds(180), // Lambda timeout = 30s, so 6x = 180s
// Without this: SQS re-delivers message while Lambda is still processing it → duplicate processing
```

---

## Failure Handling

| Failure | Behavior | Recovery |
|---|---|---|
| Groq API down | Fail open — order proceeds | No customer impact |
| Inventory Lambda throws | SQS retries 3x → DLQ | CloudWatch alarm fires, message preserved |
| Duplicate API request | DDB condition rejects | No duplicate, idempotent |
| Race condition on stock | ConditionalCheckFailedException caught | Order → FAILED_INSUFFICIENT_STOCK |
| SES fails | Notifier Lambda throws → SQS retries 3x → DLQ | Alarm fires, can redrive from DLQ |

---

## Observability

- **CloudWatch Logs** — all Lambda invocations logged automatically, structured JSON
- **X-Ray Tracing** — trace a single `orderId` across all 3 Lambda invocations in one waterfall view
- **DLQ Alarms** — CloudWatch alarm fires as soon as any message hits either DLQ
- **Order Status** — query DDB directly to see `PENDING → CONFIRMED / FAILED_INSUFFICIENT_STOCK`

```bash
# View logs for Order Lambda
aws logs tail /aws/lambda/OrderLambda --follow

# Open X-Ray in AWS Console
# Service Map → click any Lambda → see traces per request
```

---

## Teardown

```bash
# Destroy all AWS resources
cdk destroy --all

# Clean up SSM
aws ssm delete-parameter --name "/order-system/groq-api-key"
```

> Always teardown after the weekend to avoid any surprise charges.

---

## Why DynamoDB and Not RDS?

| Concern | DynamoDB | RDS |
|---|---|---|
| Lambda connection scaling | HTTP-based, infinite connections | Connection pool exhaustion at ~100 concurrent Lambdas |
| Idle cost | $0 with PAY_PER_REQUEST | ~$15–30/month minimum |
| Access patterns | Single-key lookups — DDB's sweet spot | Needed for JOINs, complex queries, reporting |
| Atomic operations | Condition expressions handle it | Needs transactions + SELECT FOR UPDATE |

Use RDS when you need JOINs, complex reporting, or unknown access patterns. Use both in production — DynamoDB for the hot path, RDS/Aurora for analytics.

---

## What This Teaches You

| Pattern | Where | Interview Value |
|---|---|---|
| SNS fan-out | SNS → 2x SQS | Asked in every distributed systems design round |
| DLQ + retry behavior | Both SQS queues | Reliability = senior-level signal |
| Atomic condition expressions | Inventory Lambda | Concurrency + idempotency questions |
| Fail-open AI design | Fraud check | AI system design is the new frontier |
| CDK cross-stack refs | All 3 stacks | Shows IaC maturity |
| Race condition prevention | Stock decrement | Tier-1 interview topic |
| Distributed tracing | X-Ray on all Lambdas | Observability = senior expectation |

---

*Built as a weekend project. Free tier. Zero to deployed in ~6 hours.*