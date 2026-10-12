import { createConnection } from "node:net";

import { ConsoleSpanExporter, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

interface Scenario {
  receiverStatus: number;
  traceparent?: string;
  tracestate?: string;
}

interface ObservedRequest {
  path: string;
  traceId?: string;
  spanId?: string;
  traceparent: string | undefined;
  tracestate: string | undefined;
}

async function sendRequest(address: string, scenario: Scenario): Promise<number> {
  const target = new URL(address);
  const body = JSON.stringify({ eventType: "invoice.created", data: { invoiceId: "inv_trace_test" } });
  const headers = [
    "POST /events HTTP/1.1",
    `Host: ${target.host}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  if (scenario.traceparent !== undefined) headers.push(`traceparent: ${scenario.traceparent}`);
  if (scenario.tracestate !== undefined) headers.push(`tracestate: ${scenario.tracestate}`);

  // Raw TCP keeps client-side auto-instrumentation from replacing the test headers.
  return new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(target.port) });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy(new Error("Test request timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${headers.join("\r\n")}\r\n\r\n${body}`));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1];
      if (status === undefined) reject(new Error("Test request received no HTTP status"));
      else resolve(Number(status));
    });
  });
}

async function runScenario(scenario: Scenario) {
  const exporter = new InMemorySpanExporter();
  const originalExport = ConsoleSpanExporter.prototype.export;
  // Capture the production SDK's spans without parsing diagnostic console text.
  ConsoleSpanExporter.prototype.export = exporter.export.bind(exporter);
  const { shutdownTelemetry } = await import("../../src/instrumentation.js");
  const { buildApp } = await import("../../src/app.js");
  const { HttpDeliveryClient } = await import("../../src/delivery.js");
  const { activeTraceFields } = await import("../../src/telemetry.js");
  const { captureLogger } = await import("../helpers/capture-logger.js");
  const captured = captureLogger();
  const requests: ObservedRequest[] = [];
  let receiverUrl: string;
  const app = buildApp({
    logger: captured.logger,
    mockReceiverStatusCode: scenario.receiverStatus,
    deliveryClient: {
      async deliver(event) {
        await new HttpDeliveryClient(receiverUrl, 5000).deliver(event);
      },
    },
  });
  app.addHook("onRequest", async (request) => {
    requests.push({
      path: request.url,
      ...activeTraceFields(),
      traceparent: typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined,
      tracestate: typeof request.headers.tracestate === "string" ? request.headers.tracestate : undefined,
    });
  });

  let responseStatus: number;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    receiverUrl = `${address}/mock/webhooks`;
    responseStatus = await sendRequest(address, scenario);
  } finally {
    try {
      await app.close();
    } finally {
      try {
        await Promise.all([shutdownTelemetry(), captured.close()]);
      } finally {
        ConsoleSpanExporter.prototype.export = originalExport;
      }
    }
  }

  return {
    responseStatus,
    requests,
    spans: exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      kind: span.kind,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      traceState: span.spanContext().traceState?.serialize(),
      attributes: span.attributes,
      scope: span.instrumentationScope,
    })),
    logs: captured.records.filter((record) => record.eventId !== undefined),
  };
}

export type HttpTraceScenarioResult = Awaited<ReturnType<typeof runScenario>>;

const scenario = JSON.parse(process.argv[2] ?? "{}") as Scenario;
console.log("TRACE_SCENARIO=" + JSON.stringify(await runScenario(scenario)));
