export interface AppConfig {
  deliveryTargetUrl: string;
  deliveryTimeoutMs: number;
  host: string;
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPositiveInteger(environment.PORT, 3000);

  return {
    host: environment.HOST ?? "0.0.0.0",
    port,
    deliveryTargetUrl:
      environment.DELIVERY_TARGET_URL ?? `http://127.0.0.1:${port}/mock/webhooks`,
    deliveryTimeoutMs: readPositiveInteger(environment.DELIVERY_TIMEOUT_MS, 3000),
  };
}
