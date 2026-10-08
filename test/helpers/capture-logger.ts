import Fastify from "fastify";

export function captureLogger() {
  const records: Record<string, unknown>[] = [];
  const owner = Fastify({
    logger: {
      stream: {
        write(message: string) {
          records.push(JSON.parse(message) as Record<string, unknown>);
        },
      },
    },
  });

  return {
    logger: owner.log.child({ component: "logging-test" }),
    records,
    close: () => owner.close(),
  };
}
