import { describe, expect, it } from "bun:test";
import {
  acquireSdkAgent,
  buildAgentOptions,
  normalizeSdkModelId,
  sdkMessageToStreamJson,
} from "../../scripts/sdk-runner.mjs";

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

describe("sdk-runner usage mapping", () => {
  it("preserves SDK usage for OpenAI response accounting", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      totalTokens: 210,
      reasoningTokens: 5,
    };

    expect(sdkMessageToStreamJson({ type: "usage", usage })).toEqual({
      type: "result",
      subtype: "usage",
      usage,
    });
  });
});

describe("sdk-runner model mapping", () => {
  it("maps Cursor CLI variants to SDK model IDs", () => {
    expect(normalizeSdkModelId("claude-sonnet-5-high")).toBe("claude-sonnet-5");
    expect(normalizeSdkModelId("claude-sonnet-5-thinking-xhigh")).toBe("claude-sonnet-5");
    expect(normalizeSdkModelId("claude-4.6-sonnet-medium")).toBe("claude-sonnet-4-6");
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

describe("sdk-runner conversations", () => {
  it("reuses an isolated agent and sends only the incremental follow-up", async () => {
    const created: any[] = [];
    const createAgent = async () => {
      const agent = { id: created.length + 1 };
      created.push(agent);
      return agent;
    };
    const cache = new Map();
    const request = {
      model: "claude-sonnet-4",
      cwd: "/workspace",
      prompt: "USER: Remember BETA",
      conversationKey: "session-1\0build",
    };

    const first = await acquireSdkAgent("cursor_123", request, cache, createAgent);
    const second = await acquireSdkAgent("cursor_123", {
      ...request,
      prompt: "USER: Remember BETA\n\nASSISTANT: Got it.\n\nUSER: What was the codeword?",
      incrementalPrompt: "What was the codeword?",
    }, cache, createAgent);
    const title = await acquireSdkAgent("cursor_123", {
      ...request,
      conversationKey: "session-1\0title",
      prompt: "Generate a title",
    }, cache, createAgent);

    expect(created).toHaveLength(2);
    expect(second.agent).toBe(first.agent);
    expect(second.prompt).toBe("What was the codeword?");
    expect(title.agent).not.toBe(first.agent);
  });
});
