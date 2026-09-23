import { describe, expect, it } from "bun:test";
import { buildAgentOptions, sdkMessageToStreamJson } from "../../scripts/sdk-runner.mjs";

describe("sdk-runner MCP remapping", () => {
  it("sanitizes generic SDK mcp tool calls with the same namespace convention as OpenCode MCP tools", () => {
    const event = sdkMessageToStreamJson({
      type: "tool_call",
      call_id: "call-1",
      name: "mcp",
      args: {
        providerIdentifier: "hybrid-memory",
        toolName: "memory-search",
        args: { query: "release notes" },
      },
    });

    expect(event).toEqual({
      type: "tool_call",
      call_id: "call-1",
      tool_call: {
        mcp__hybrid_memory__memory_search: {
          args: { query: "release notes" },
          result: undefined,
        },
      },
    });
  });
});

describe("sdk-runner agent options", () => {
  it("uses the replacement OpenCode prompt with strict worker isolation", () => {
    const options = buildAgentOptions({
      apiKey: "cursor_123",
      model: "auto",
      cwd: "/workspace",
      systemPrompt: "OpenCode system",
    });

    expect(options.systemPrompt).toBe("OpenCode system");
    expect(options.local.settingSources).toEqual([]);
    expect(options.disallowedTools).toEqual(["task"]);
    expect(options).not.toHaveProperty("agents");
  });

  it("omits the replacement prompt while preserving strict worker isolation", () => {
    const options = buildAgentOptions({
      apiKey: "cursor_123",
      model: "auto",
      cwd: "/workspace",
    });

    expect(options).not.toHaveProperty("systemPrompt");
    expect(options.local.settingSources).toEqual([]);
    expect(options.disallowedTools).toEqual(["task"]);
  });
});
