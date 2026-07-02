import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../logger/logger.js";

function memorySink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe("createLogger", () => {
  it("writes JSON lines with the scope", () => {
    const { lines, stream } = memorySink();
    const log = createLogger("engine", { destination: stream });
    log.info("started");
    const entry = JSON.parse(lines[0]);
    expect(entry.scope).toBe("engine");
    expect(entry.msg).toBe("started");
  });

  it("child loggers carry correlation ids", () => {
    const { lines, stream } = memorySink();
    const log = createLogger("engine", { destination: stream });
    log.child({ runId: "run-1", nodeId: "n-2" }).warn("slow step");
    const entry = JSON.parse(lines[0]);
    expect(entry.runId).toBe("run-1");
    expect(entry.nodeId).toBe("n-2");
    expect(entry.scope).toBe("engine");
  });
});
