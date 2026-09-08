export interface AppConfig {
  deliveryTargetUrl: string;
  deliveryTimeoutMs: number;
  host: string;
  mockReceiverStatusCode: number;
  port: number;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${value}`);
  }

  return parsed;
}

function readHttpStatus(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 200 || parsed > 599) {
    throw new Error(`Expected an HTTP status from 200 to 599 but received: ${value}`);
  }

  return parsed;
}

function readHttpUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Expected DELIVERY_TARGET_URL to be a valid HTTP URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Expected DELIVERY_TARGET_URL to be a valid HTTP URL");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("DELIVERY_TARGET_URL must not contain credentials");
  }

  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPositiveInteger(environment.PORT, 3000);
  const deliveryTargetUrl =
    environment.DELIVERY_TARGET_URL ??
    `http://127.0.0.1:${port}/mock/webhooks`;

  return {
    host: environment.HOST ?? "0.0.0.0",
    port,
    deliveryTargetUrl: readHttpUrl(deliveryTargetUrl),
    deliveryTimeoutMs: readPositiveInteger(environment.DELIVERY_TIMEOUT_MS, 3000),
    mockReceiverStatusCode: readHttpStatus(
      environment.MOCK_RECEIVER_STATUS_CODE,
      200,
    ),
  };
}
