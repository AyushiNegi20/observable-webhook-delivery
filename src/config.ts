import { isIP } from "node:net";

import type { LogLevel } from "fastify";

export interface AppConfig {
  deliveryTargetUrl: string;
  deliveryTimeoutMs: number;
  host: string;
  logLevel: LogLevel;
  mockReceiverDelayMs: number;
  mockReceiverStatusCode: number;
  port: number;
}

function readLogLevel(value: string | undefined): LogLevel {
  const levels: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
  const level = levels.find((candidate) => candidate === (value ?? "info").trim());
  if (level === undefined) {
    throw new Error("Expected LOG_LEVEL to be trace, debug, info, warn, error, fatal, or silent");
  }
  return level;
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

function readPort(value: string | undefined): number {
  const port = readPositiveInteger(value, 3000);
  if (port > 65535) {
    throw new Error(`Expected PORT to be at most 65535 but received: ${value}`);
  }

  return port;
}

function readDeliveryTimeout(value: string | undefined): number {
  const timeoutMs = readPositiveInteger(value, 3000);
  if (timeoutMs > 60_000) {
    throw new Error(
      `Expected DELIVERY_TIMEOUT_MS to be at most 60000 but received: ${value}`,
    );
  }

  return timeoutMs;
}

function readHost(value: string | undefined): string {
  if (value === undefined) {
    return "0.0.0.0";
  }

  const host = value.trim();
  if (host === "") {
    throw new Error("Expected HOST to be a non-empty value");
  }

  return host;
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

function readMockReceiverDelay(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }

  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error("Expected MOCK_RECEIVER_DELAY_MS to be an integer between 0 and 60000");
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

  if (parsed.hash !== "") {
    throw new Error("DELIVERY_TARGET_URL must not contain a fragment");
  }

  return value;
}

function localDeliveryTarget(host: string, port: number): string {
  const hostname = isIP(host) === 6 ? `[${host}]` : host;
  const target = new URL(`http://${hostname}:${port}/mock/webhooks`);
  // Wildcard bind addresses need a concrete loopback address for delivery.
  if (target.hostname === "0.0.0.0") target.hostname = "127.0.0.1";
  if (target.hostname === "[::]") target.hostname = "[::1]";
  return target.href;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPort(environment.PORT);
  const host = readHost(environment.HOST);
  const deliveryTargetUrl =
    environment.DELIVERY_TARGET_URL ??
    localDeliveryTarget(host, port);

  return {
    host,
    port,
    logLevel: readLogLevel(environment.LOG_LEVEL),
    deliveryTargetUrl: readHttpUrl(deliveryTargetUrl),
    deliveryTimeoutMs: readDeliveryTimeout(environment.DELIVERY_TIMEOUT_MS),
    mockReceiverDelayMs: readMockReceiverDelay(environment.MOCK_RECEIVER_DELAY_MS),
    mockReceiverStatusCode: readHttpStatus(
      environment.MOCK_RECEIVER_STATUS_CODE,
      200,
    ),
  };
}
