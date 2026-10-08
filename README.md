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
- Request identifiers returned in the `x-request-id` response header
- Cache prevention on all API responses
- MIME sniffing protection on API responses
- Request validation and delivery timeouts
- Rejection of unknown request fields
- Startup validation for host and port settings
- Startup validation for the webhook destination URL
- A 256 KB request body limit
- Unit and integration tests
- Docker support
- Continuous integration with GitHub Actions
- Automatic tracing for incoming and outgoing HTTP requests
- A custom span for the webhook delivery operation
- Delivery attempt, failure, in-progress, and duration metrics
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

Request fields are validated without type conversion. `eventType` must be a
string and `data` must be a JSON object; numbers, booleans, or arrays are not
converted to fit those fields. Values inside `data` can still contain nested
objects, arrays, numbers, booleans, strings, and null. The mock receiver applies
the same rules and requires string values for `id` and `createdAt`.

### Health check

```http
GET /health
```

The response identifies the service as `webhook-api` and reports its current
status and application version.

API responses use `Cache-Control: no-store` so clients and operational checks
always receive current results.

Every request gets a server-generated UUID, returned in `x-request-id` and used
as `reqId` in request logs. This avoids restarting the same request ID sequence
when a process restarts or another instance starts. Incoming `x-request-id`
headers are ignored. Error responses also include the generated ID so a failed
request can be found in the logs. Request IDs are separate from trace IDs and
are not metric labels.

### Mock receiver

```http
POST /mock/webhooks
```

The mock receiver is the only configured destination in the first milestone. Arbitrary destination URLs are intentionally not accepted from API clients.

Outgoing deliveries include `x-webhook-id`, `x-webhook-event`,
`x-webhook-created-at`, `x-webhook-attempt`, and `x-webhook-schema-version`
headers so receivers can identify and order events before parsing the payload.
The schema version is currently `1`. The attempt is currently always `1` and will
increase when retries are introduced. The `User-Agent` header identifies this
delivery service in receiver access logs.

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

Delivery timeouts must be positive and cannot exceed 60 seconds.

Delivery errors distinguish an expired deadline (`timeout`), a transport failure
(`network`), and a non-successful HTTP response (`http_status`). Unclassified
delivery errors use `unknown`. The public API keeps its generic `502` response;
the reason is available on the internal error for troubleshooting.

HTTP response failures also preserve the receiver's numeric `statusCode` on the
internal error. Network failures and timeouts leave it undefined because no HTTP
response status was received.

Keep API keys and credentials in local environment files, never in committed source code. Files matching `.env.*` are ignored, while `.env.example` remains available as a safe configuration template.

Credentials embedded directly in `DELIVERY_TARGET_URL` are rejected because URLs
may appear in HTTP telemetry. Authentication should be added through a dedicated
secret-backed header in a later milestone.

Webhook redirects are disabled so payloads are only sent to the configured
destination. URL fragments are rejected because they are not transmitted in HTTP
requests.

A blocked redirect currently appears as a `network` delivery failure without a
receiver status code because `fetch` rejects it before exposing the response.
HTTP integration tests cover 301, 302, 303, 307, and 308 redirects with both
relative and absolute locations, checking that the redirect target receives no
request.

Unused receiver response bodies are cancelled after the response headers arrive.
The service does not parse or log those bodies, and cleanup failures do not change
the delivery result determined by the HTTP status.

## OpenTelemetry output

OpenTelemetry starts before the application so it can instrument incoming HTTP requests and outgoing calls made with `fetch`. Traces and metrics are exported to the console during this learning milestone.

`OTEL_SERVICE_NAME` defaults to `webhook-api`. Surrounding whitespace is trimmed,
and blank names are rejected at startup so telemetry always has a service name.

`OTEL_METRIC_EXPORT_INTERVAL_MS` defaults to `5000`. It must be an integer from
`1` to `2147483647` milliseconds. Larger values exceed Node's timer range and are
rejected at startup instead of being reduced to a one-millisecond interval.

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
| `webhook.delivery.active` | UpDownCounter | Counts deliveries currently in progress |
| `webhook.delivery.duration` | Histogram | Records delivery time in milliseconds |

The duration histogram includes bucket boundaries at 2, 3, 30, and 60 seconds,
alongside finer buckets for fast deliveries. These make it easier to see latency
near the default three-second timeout and the maximum supported timeout. Bucket
boundaries do not change the delivery timeout itself.

The active delivery count increases when a delivery starts and decreases when it
finishes, including failed deliveries. It measures in-progress work in this
process, not queued events. Short deliveries may finish between metric exports,
so use the attempt counter to measure total traffic.

Delivery logs include the active `traceId` and `spanId` when the span context is
valid. Missing or invalid contexts are omitted instead of logging all-zero IDs.
Valid IDs are retained even when the trace is not sampled. Event payloads are not
added to telemetry.

When using `buildApp` directly, its `logger` option accepts a compatible logger
instance as well as `true` or `false`. A supplied logger retains its bindings and
receives both request logs and delivery logs. Omitting it enables JSON logging.

To simulate an unavailable destination, restart the application with:

```text
MOCK_RECEIVER_STATUS_CODE=503
```

The `/events` endpoint will return `502`, the delivery span will have an error status, and the failure counter will increase.

Each completed `webhook.deliver` span includes `webhook.delivery.result`, set to
`success` or `failure`. The duration histogram uses the same attribute, so traces
and delivery timing measurements can be filtered by the same outcome.

Failed delivery spans and the failure counter include
`webhook.delivery.failure_reason`: `timeout`, `network`, `http_status`, `unknown`,
or `unexpected`. The last category covers errors outside `DeliveryError`. These
fixed categories let you group failures without putting exception messages into
metric labels. Successful delivery spans do not include a failure reason.

Failed delivery spans also include `http.response.status_code` when the receiver
returned an HTTP response. Timeouts and network failures omit this attribute.
The receiver status is not added to metric labels.

Telemetry shutdown runs once. Concurrent shutdown requests wait for the same
exporter flush, and all callers receive the same completion result. A failed
shutdown remains visible to later callers instead of being reported as successful.

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

Trace-context tests check parent-child relationships across asynchronous work,
parent-context restoration after success or failure, and log identifier isolation
between concurrent deliveries.

HTTP integration tests start a temporary receiver on the loopback interface and
use real requests to check successful responses, no-content responses, receiver
errors, and delivery timeouts together with their custom spans. They do not need
external services.

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
