import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger } from "../src/index.js";

function capture(): { lines: Array<Record<string, unknown>>; stream: PassThrough } {
  const stream = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  stream.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim().length > 0) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  });
  return { lines, stream };
}

describe("structured logger", () => {
  it("emits one JSON object per line with service, level and ISO time", () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: "test-svc", level: "info", destination: stream });
    logger.info({ requestId: "r-1" }, "hello mesh");
    const entry = lines[0]!;
    expect(entry.service).toBe("test-svc");
    expect(entry.level).toBe(30); // pino numeric level for info
    expect(entry.msg).toBe("hello mesh");
    expect(entry.requestId).toBe("r-1");
    expect(typeof entry.time).toBe("string");
    expect(String(entry.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("redacts sensitive keys at any nesting depth", () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: "test-svc", level: "info", destination: stream });
    logger.warn({ privateKey: "super-secret", nested: { privateKey: "also-secret" } }, "careful");
    const entry = lines[0]!;
    expect(entry.privateKey).toBe("[redacted]");
    expect((entry.nested as Record<string, unknown>).privateKey).toBe("[redacted]");
  });

  it("child loggers inherit service and add bindings", () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: "test-svc", level: "debug", destination: stream });
    const child = logger.child({ component: "policy-engine" });
    child.debug("from child");
    const entry = lines[0]!;
    expect(entry.service).toBe("test-svc");
    expect(entry.component).toBe("policy-engine");
  });

  it("respects the configured level", () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: "test-svc", level: "error", destination: stream });
    logger.info("ignored");
    logger.error("kept");
    expect(lines.length).toBe(1);
    expect(lines[0]!.msg).toBe("kept");
  });
});
