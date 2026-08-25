# Observable Webhook Delivery

A webhook delivery service built to explore observability in a realistic event delivery pipeline. The project starts with a small synchronous service and will grow to include background processing, retries, distributed tracing, metrics, and correlated logs with OpenTelemetry.

## Current architecture

```text
Client -> Webhook API -> Mock receiver
```

The first milestone provides:

- A webhook event API
- A local mock receiver
- JSON request logging
- Request validation and delivery timeouts
- Unit and integration tests
- Docker support
- Continuous integration with GitHub Actions

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

Copy `.env.example` to `.env` to change the host, port, delivery target, or timeout. Environment variables can also be supplied directly to the process.

## Commands

```bash
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## Run with Docker

```bash
docker build -t observable-webhook-delivery .
docker run --rm -p 3000:3000 observable-webhook-delivery
```

## Roadmap

Planned milestones include:

1. Add OpenTelemetry traces and custom spans.
2. Add delivery metrics and trace-correlated logs.
3. Route telemetry through an OpenTelemetry Collector.
4. Store events in PostgreSQL.
5. Move delivery work to a Redis-backed queue and worker.
6. Add retries, a dead-letter queue, and controllable failure scenarios.
7. Add dashboards and documented incident investigations.

## Design notes

Webhook payloads and secrets should not be recorded in telemetry. Event identifiers may be useful on individual traces and logs, but should not be used as metric labels because their high cardinality would create unnecessary cost and operational pressure.
