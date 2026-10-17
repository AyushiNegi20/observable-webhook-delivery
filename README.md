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
- A 256 KiB event request limit and a separate mock receiver limit
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

The health response and OpenTelemetry's `service.version` both read the version
from `package.json`, so a version bump does not leave either value behind.

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

`POST /events` accepts at most 262144 bytes (256 KiB). The mock receiver allows
2097152 bytes (2 MiB) to leave room for the generated event ID and timestamp, plus
size changes when parsed JSON is serialized for delivery. For example, some
numbers written in exponent notation become longer decimal strings. Both limits
apply to the complete request body in bytes, not the number of characters in a
field. External receivers enforce their own limits.

A body exactly at its endpoint's limit is accepted if it passes validation; one
byte over returns `413` before the handler runs. UTF-8 text can use multiple bytes
per character, so a character count is not a reliable size check. Use
`Buffer.byteLength(JSON.stringify(body), "utf8")` when checking a body in Node.js.

Invalid schemas, malformed JSON, oversized bodies, and unsupported content types
are rejected before delivery starts. They do not create a `webhook.deliver` span
or change the delivery counters and duration histogram. Request logs and automatic
HTTP spans can still record the rejected request. This keeps bad input separate
from failures that occur while trying to reach a receiver.

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

Copy `.env.example` to `.env` to change the host, port, delivery target, timeout,
mock receiver status, or telemetry settings. Startup loads `.env` from the working
directory before configuring OpenTelemetry. Variables already set in the process
take precedence over the file. A missing `.env` is allowed; other file-reading
errors stop startup instead of silently ignoring configuration.

`HOST` defaults to `0.0.0.0`. Surrounding whitespace is trimmed before the server
binds, and an empty or whitespace-only value is rejected.

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

Custom delivery spans and metrics use the `observable-webhook-delivery`
instrumentation scope with the application version from `package.json`. The
resource's `service.version` identifies the running application; the scope
identifies the code that created those signals. Automatic HTTP instrumentation
keeps its own library name and version.

`OTEL_SERVICE_NAME` defaults to `webhook-api`. Surrounding whitespace is trimmed,
and blank names are rejected at startup so telemetry always has a service name.

`OTEL_METRIC_EXPORT_INTERVAL_MS` defaults to `5000`. It must be an integer from
`1` to `2147483647` milliseconds. Larger values exceed Node's timer range and are
rejected at startup instead of being reduced to a one-millisecond interval.

A delivery produces automatic HTTP spans and a custom business span:

```text
POST /events (HTTP server)
  webhook.deliver (custom)
    POST /mock/webhooks (HTTP client)
      POST /mock/webhooks (HTTP server)
```

The incoming `traceparent` header connects the API request to a caller's trace.
Outgoing delivery carries that context to the receiver, preserving the trace ID
while each operation gets its own span ID. A valid `tracestate` also travels with
the request. Missing or invalid trace headers start a new trace. With the default
parent-based sampler, an unsampled caller's context still propagates and appears
in logs, but its spans are not exported.

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

Completed and failed delivery logs include `durationMs`, measured with a monotonic
clock. This is the elapsed delivery operation time, not the full incoming request
time or the mock receiver's configured delay. It can contain fractional
milliseconds. Started logs omit it because the outcome is still pending.

Failed delivery logs expose `failureReason` as a top-level field, using the same
classification as the delivery span and failure counter. A receiver's HTTP
response adds `statusCode`; network errors and timeouts omit it. This lets you
filter logs without parsing the nested `err` object, which is retained for
diagnostics. Successful delivery logs omit both failure fields, and the public
API still returns its generic error response.

When using `buildApp` directly, its `logger` option accepts a compatible logger
instance as well as `true` or `false`. A supplied logger retains its bindings and
receives both request logs and delivery logs. Omitting it enables JSON logging.

To simulate an unavailable destination, restart the application with:

```text
MOCK_RECEIVER_STATUS_CODE=503
```

The `/events` endpoint will return `502`, the delivery span will have an error status, and the failure counter will increase.

To simulate a slow receiver, set `MOCK_RECEIVER_DELAY_MS` in `.env` and restart.
It defaults to `0` and accepts whole numbers from `0` to `60000` milliseconds.
For example, `MOCK_RECEIVER_DELAY_MS=1000` adds a one-second delay before the mock
receiver responds. A delay above `DELIVERY_TIMEOUT_MS` lets you practice a timeout
incident. This setting affects only the mock receiver, not health checks or an
external delivery destination.

The mock receiver logs successful 2xx responses at info level and rejected
deliveries at warning level. Its log includes `statusCode` and `received`, along
with the event and request identifiers, so a simulated 503 is not reported as
an accepted webhook. The event payload is not included.

Receiver logs also include `delayMs`, the configured simulated delay. This is
not a measurement of total request time; use delivery spans and the duration
histogram to investigate observed latency. The delay is not a metric label.

A timeout exercise can use these `.env` values:

```text
MOCK_RECEIVER_STATUS_CODE=200
MOCK_RECEIVER_DELAY_MS=4000
DELIVERY_TIMEOUT_MS=3000
```

Restart the service and submit an event. The API returns `502`, and the delivery
span reports `webhook.delivery.failure_reason=timeout`. The mock receiver can
still log an accepted webhook later. A timeout means the sender stopped waiting,
not that the receiver necessarily stopped processing. Slow-receiver integration
tests cover this case and a delayed success using a real local HTTP connection.

Each completed `webhook.deliver` span includes `webhook.delivery.result`, set to
`success` or `failure`. The duration histogram uses the same attribute, so traces
and delivery timing measurements can be filtered by the same outcome.

Failed delivery spans and the failure counter include
`webhook.delivery.failure_reason`: `serialization`, `timeout`, `network`,
`http_status`, `unknown`, or `unexpected`. The last category covers errors outside
`DeliveryError`. These fixed categories let you group failures without putting
exception messages into metric labels. Successful delivery spans do not include
a failure reason.

`serialization` means the event could not be converted to an outgoing JSON body.
No HTTP request or delivery timeout is started in that case. This can happen with
very deeply nested JSON, or with circular references and BigInt values supplied
by an in-process caller. It is a failed delivery attempt, not a network outage.
The original exception remains available as the error cause for diagnostics.

An API regression test submits valid JSON below the request size limit but too
deep for the runtime to serialize. It checks the failure log, span, counter, and
duration observation, then sends a normal event through the same application.
The normal event succeeds, the active count returns to zero, and the earlier
serialization failure remains counted.

Failed delivery spans also include `http.response.status_code` when the receiver
returned an HTTP response. Timeouts and network failures omit this attribute.
The receiver status is not added to metric labels.

Telemetry shutdown runs once. Concurrent shutdown requests wait for the same
exporter flush, and all callers receive the same completion result. A failed
shutdown remains visible to later callers instead of being reported as successful.

On shutdown, server cleanup finishes before the telemetry flush begins. The flush
is still attempted if server cleanup throws, and failures from both steps are
preserved if both fail. A cleanup failure makes the process exit unsuccessfully.

If the server cannot start listening, it logs the startup error, closes the
application, and flushes telemetry before exiting with a failure status. Any
cleanup error is logged separately so the original startup failure stays visible.

Application configuration and construction failures also flush an already-started
telemetry SDK. If the application logger is not available yet, the startup error
and any cleanup error go to stderr. The process exits with code `1`, and signal
handlers are not installed until the application has been constructed.

Repeated `SIGINT` or `SIGTERM` signals, including a mix of both, run cleanup and
process exit only once. The handlers stay installed while cleanup is in progress,
so another signal does not bypass the pending telemetry flush. Signal handling
and failed-startup cleanup share the same resource shutdown operation. The process
waits for that operation before exiting, including when telemetry flushing fails.

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

Environment startup tests use fresh Node processes and temporary directories to
check missing files, file-based settings, and process-variable precedence. They
do not read or change your local `.env` file.

Failed-startup tests buffer a probe span and counter in the actual application
SDK, then trigger invalid configuration or an occupied local port. They verify
that both signals are exported before exit code `1`, without waiting for the
normal export interval. Exports are captured in memory; no external telemetry
service is needed, and these tests do not load your local `.env` file.

Trace-context tests check parent-child relationships across asynchronous work,
parent-context restoration after success or failure, and log identifier isolation
between concurrent deliveries.

HTTP propagation tests start the application's actual SDK in fresh Node processes
and send requests through both HTTP hops. They check the four-span parent chain,
trace-correlated logs, receiver failures, missing or invalid headers, and an
unsampled parent. These tests capture spans in memory, use only loopback ports,
and run from temporary directories without loading your local `.env` file.

Log-correlation tests submit successful and failed events through the API and
match the captured delivery logs to exported spans. They verify request and
event identifiers, log levels, and the absence of synthetic payload and
authorization-header markers in those logs and custom spans.

HTTP integration tests start a temporary receiver on the loopback interface and
use real requests to check successful responses, no-content responses, receiver
errors, and delivery timeouts together with their custom spans. They do not need
external services.

The sender uses the receiver's HTTP status to decide the delivery outcome; it
does not read the response body. Integration tests cover both `200` and `503`
responses whose bodies never finish. They check that delivery completes, the
unused response is cancelled before the timeout, and the span and metrics keep
the HTTP outcome instead of reporting a timeout. Cancelling the response does
not undo any processing already performed by the receiver.

These tests also check exported attempt and failure counts, the active count
returning to zero, and duration histogram observations for each outcome. A
recovery scenario sends a failed request followed by successful ones: attempts
keep increasing, the earlier failure remains counted, and active work returns to
zero after each delivery. Recovery does not reset cumulative counters.

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
