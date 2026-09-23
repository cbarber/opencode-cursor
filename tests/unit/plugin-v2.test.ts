import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configHome = mkdtempSync(join(tmpdir(), "open-cursor-v2-"));
const previousEnv = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  CURSOR_ACP_MCP_BRIDGE: process.env.CURSOR_ACP_MCP_BRIDGE,
  CURSOR_ACP_MODEL_AUTO_REFRESH: process.env.CURSOR_ACP_MODEL_AUTO_REFRESH,
  CURSOR_ACP_REUSE_EXISTING_PROXY: process.env.CURSOR_ACP_REUSE_EXISTING_PROXY,
};

process.env.XDG_CONFIG_HOME = configHome;
process.env.OPENCODE_CONFIG = join(configHome, "missing.json");
process.env.CURSOR_ACP_MCP_BRIDGE = "false";
process.env.CURSOR_ACP_MODEL_AUTO_REFRESH = "false";
process.env.CURSOR_ACP_REUSE_EXISTING_PROXY = "false";

const pluginModule = await import("../../src/plugin.js") as typeof import("../../src/plugin.js") & {
  getStoredApiKey?: () => string | undefined;
};
const { createV2Setup } = await import("../../src/plugin-v2.js");

type Registration = { dispose: () => Promise<void> };

function registration(onDispose: () => void = () => {}): Registration {
  return { dispose: async () => onDispose() };
}

function createContext() {
  const disposed: string[] = [];
  const toolAddCalls: any[][] = [];
  let httpRequestHook: ((event: any) => Promise<void>) | undefined;
  let sessionContextHook: ((event: any) => Promise<void>) | undefined;
  let activeConnectionCalls = 0;
  let credential: any = { type: "key", key: "cursor-key" };
  const provider: Record<string, any> = {
    id: "cursor-acp",
    name: "Old Cursor",
    package: "@ai-sdk/openai-compatible",
    settings: { baseURL: "http://127.0.0.1:9/v1", keep: true },
  };

  const context = {
    catalog: {
      transform: async (callback: (draft: any) => void) => {
        callback({
          provider: {
            update: (id: string, update: (value: any) => void) => {
              expect(id).toBe("cursor-acp");
              update(provider);
            },
          },
        });
        return registration(() => disposed.push("catalog"));
      },
    },
    integration: {
      transform: async (callback: (draft: any) => void) => {
        callback({ method: { update: () => {} } });
        return registration(() => disposed.push("integration"));
      },
      connection: {
        active: async () => {
          activeConnectionCalls += 1;
          return { id: "cursor-connection" };
        },
        resolve: async () => credential,
      },
    },
    tool: {
      transform: async (callback: (draft: any) => void) => {
        callback({ add: (...args: any[]) => toolAddCalls.push(args) });
        return registration(() => disposed.push("tool"));
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        if (name === "context") sessionContextHook = callback;
        else if (name === "http.request") httpRequestHook = callback;
        else throw new Error(`Unexpected session hook: ${name}`);
        return registration(() => disposed.push(`session:${name}`));
      },
    },
  };

  return {
    context,
    disposed,
    provider,
    toolAddCalls,
    activeConnectionCalls: () => activeConnectionCalls,
    setCredential: (value: any) => { credential = value; },
    httpRequestHook: () => httpRequestHook,
    sessionContextHook: () => sessionContextHook,
  };
}

afterAll(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(configHome, { recursive: true, force: true });
});

describe("opencode V2 adapter", () => {
  test("writes the proxy URL through provider settings", async () => {
    const { context, provider } = createContext();

    await createV2Setup()(context);

    expect(provider.package).toBe("@ai-sdk/openai-compatible");
    expect(provider.settings.keep).toBe(true);
    expect(provider.settings.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(provider.settings.baseURL).not.toBe("http://127.0.0.1:9/v1");
    expect(provider.api).toBeUndefined();
  });

  test("routes Cursor HTTP requests to the live proxy after config overlays", async () => {
    const fixture = createContext();
    await createV2Setup()(fixture.context);
    const event = {
      model: { providerID: "cursor-acp" },
      request: new Request("http://127.0.0.1:9/v1/chat/completions", {
        method: "POST",
        body: "probe",
      }),
    };

    await fixture.httpRequestHook()!(event);

    expect(event.request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
    expect(event.request.url).not.toContain(":9/");
    expect(await event.request.text()).toBe("probe");
  });

  test("does not register duplicate tools in opencode mode", async () => {
    const { context, toolAddCalls } = createContext();

    await createV2Setup()(context);

    expect(toolAddCalls).toEqual([]);
  });

  test("does not resolve Cursor credentials for other providers", async () => {
    const fixture = createContext();
    await createV2Setup()(fixture.context);

    await fixture.sessionContextHook()!({
      model: { providerID: "ollama" },
      system: [],
      tools: {},
    });

    expect(fixture.activeConnectionCalls()).toBe(0);
  });

  test("clears the stored key when the active connection has no credential", async () => {
    const fixture = createContext();
    await createV2Setup()(fixture.context);
    const event = {
      model: { providerID: "cursor-acp" },
      system: [],
      tools: {},
    };

    expect(pluginModule.getStoredApiKey).toBeTypeOf("function");
    await fixture.sessionContextHook()!(event);
    expect(pluginModule.getStoredApiKey!()).toBe("cursor-key");

    fixture.setCredential(undefined);
    await fixture.sessionContextHook()!(event);
    expect(pluginModule.getStoredApiKey!()).toBeUndefined();
  });

  test("does not replace the host session tool record", async () => {
    const fixture = createContext();
    await createV2Setup()(fixture.context);
    const event: any = {
      model: { providerID: "cursor-acp" },
      system: [],
      tools: undefined,
    };

    await fixture.sessionContextHook()!(event);

    expect(event.tools).toBeUndefined();
  });

  test("returns cleanup that disposes every V2 registration", async () => {
    const fixture = createContext();

    const cleanup = await createV2Setup()(fixture.context);

    expect(cleanup).toBeTypeOf("function");
    await cleanup!();
    expect(fixture.disposed.sort()).toEqual([
      "catalog", "integration", "session:context", "session:http.request",
    ]);
  });
});
