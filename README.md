# Observable Webhook Delivery

A webhook delivery service built to explore observability in a realistic event delivery pipeline. The current milestone adds OpenTelemetry traces, metrics, and trace-correlated logs to a small synchronous delivery flow.

## Current architecture

```text
Client -> Webhook API -> Mock receiver
                    |
                    +-> traces, metrics, and logs -> console
```

The project currently provides:

- A webhook event API
- A local mock receiver
- JSON request logging
- Request validation and delivery timeouts
- A 256 KB request body limit
- Unit and integration tests
- Docker support
- Continuous integration with GitHub Actions
- Automatic tracing for incoming and outgoing HTTP requests
- A custom span for the webhook delivery operation
- Delivery attempt, failure, and duration metrics
- Trace and span identifiers in delivery logs
- A configurable mock receiver failure mode

## API

### Submit an event

```http
POST /events
Content-Type: application/json
```

```json
{
  "eventType": "invoice.created",
  "data": {
    "invoiceId": "inv_123",
    "amount": 120
  }
}
```

A successful delivery returns:

```json
{
  "eventId": "8cf36e59-bd79-46bc-b29b-a2f44c1c919b",
  "status": "delivered"
}
```

### Health check

```http
GET /health
```

### Mock receiver

```http
POST /mock/webhooks
```

The mock receiver is the only configured destination in the first milestone. Arbitrary destination URLs are intentionally not accepted from API clients.

## Run locally

Requirements:

- Node.js 22 or later
- pnpm 11

Install dependencies and start the development server:

```bash
pnpm install
pnpm dev
```

The API listens on `http://localhost:3000` by default.

Copy `.env.example` to `.env` to change the host, port, delivery target, timeout, mock receiver status, or telemetry settings. Environment variables can also be supplied directly to the process.

Keep API keys and credentials in local environment files, never in committed source code. Files matching `.env.*` are ignored, while `.env.example` remains available as a safe configuration template.

## OpenTelemetry output

OpenTelemetry starts before the application so it can instrument incoming HTTP requests and outgoing calls made with `fetch`. Traces and metrics are exported to the console during this learning milestone.

A delivery produces automatic HTTP spans and a custom business span:

```text
POST /events
└── webhook.deliver
    └── POST /mock/webhooks
```

The custom metrics are:

| Metric | Instrument | Purpose |
|---|---|---|
| `webhook.delivery.attempts` | Counter | Counts delivery attempts |
| `webhook.delivery.failures` | Counter | Counts failed deliveries |
| `webhook.delivery.duration` | Histogram | Records delivery time in milliseconds |

Delivery logs include the active `traceId` and `spanId`. Event payloads are not added to telemetry.

To simulate an unavailable destination, restart the application with:

```text
MOCK_RECEIVER_STATUS_CODE=503
```

The `/events` endpoint will return `502`, the delivery span will have an error status, and the failure counter will increase.

## Commands

```bash
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm verify
```

Run `pnpm verify` before pushing to execute the complete local validation suite.

## Run with Docker

```bash
docker build -t observable-webhook-delivery .
docker run --rm -p 3000:3000 observable-webhook-delivery
```

## Roadmap

Planned milestones include:

1. Route telemetry through an OpenTelemetry Collector.
2. Store events in PostgreSQL.
3. Move delivery work to a Redis-backed queue and worker.
4. Add retries and a dead-letter queue.
5. Add dashboards and documented incident investigations.

## Design notes

Webhook payloads and secrets should not be recorded in telemetry. Event identifiers may be useful on individual traces and logs, but should not be used as metric labels because their high cardinality would create unnecessary cost and operational pressure.
