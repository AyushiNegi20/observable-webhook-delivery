export async function shutdownResources(
  closeServer: () => Promise<unknown>,
  flushTelemetry: () => Promise<unknown>,
): Promise<void> {
  const failures: unknown[] = [];

  try {
    await closeServer();
  } catch (error) {
    failures.push(error);
  }

  try {
    await flushTelemetry();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Server cleanup and telemetry shutdown failed");
  }
}
