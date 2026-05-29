/**
 * Ollama Extension for Pi
 *
 * Local Ollama + Ollama Cloud + Web Tools — all in one.
 * No local server required for cloud features (models, web search, web fetch).
 *
 * Commands: /ollama status | /ollama sync
 * Tools:    ollama_web_search, ollama_web_fetch
 * Providers: ollama (local), ollama-cloud (cloud)
 *
 * Setup:
 *   Cloud: /login → Ollama, or set OLLAMA_API_KEY env var, or auth.json
 *   Local: No setup needed if Ollama is running on localhost:11434.
 *          Custom URL via OLLAMA_HOST env var.
 *          Cloud base via OLLAMA_API_BASE env var (default: https://ollama.com).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".cache", "pi");
const CACHE_FILE = join(CACHE_DIR, "ollama-cloud-models.json");
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOKENS = 32768;
const LOCAL_BASE = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");
const CLOUD_BASE = (process.env.OLLAMA_API_BASE || "https://ollama.com").replace(/\/+$/, "");
const NO_KEY_MSG = "No Ollama Cloud API key — use /login → Ollama, set OLLAMA_API_KEY, or edit auth.json";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface OllamaShowResponse {
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
  };
  model_info: Record<string, unknown>;
  capabilities: string[];
  modified_at: string;
}

interface OllamaListModel {
  name: string;
  size?: number;
  modified_at?: string;
  details?: {
    parameter_size?: string;
    family?: string;
    families?: string[];
  };
}

interface OllamaListResponse {
  models: OllamaListModel[];
}

interface CachedData {
  timestamp: number;
  models: Record<string, OllamaShowResponse>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getContextLength(modelInfo: Record<string, unknown>): number {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") return value;
  }
  return 128_000;
}

function guessContextFromName(name: string): number {
  const l = name.toLowerCase();
  if (l.includes("llama3.1") || l.includes("llama3.2") || l.includes("llama3.3")) return 128_000;
  if (l.includes("llama3") || l.includes("llama4")) return 8192;
  if (l.includes("gemma3")) return 131_072;
  if (l.includes("gemma2") || l.includes("gemma4")) return 8192;
  if (l.includes("mistral") || l.includes("mixtral")) return 32_768;
  if (l.includes("qwen3")) return 262_144;
  if (l.includes("qwen2.5")) return 32_768;
  if (l.includes("qwen")) return 32_768;
  if (l.includes("glm")) return 202_752;
  if (l.includes("kimi")) return 262_144;
  if (l.includes("codellama")) return 16_384;
  if (l.includes("phi3") || l.includes("phi4")) return 128_000;
  if (l.includes("deepseek-r1")) return 131_072;
  if (l.includes("deepseek")) return 65_536;
  if (l.includes("qwq")) return 131_072;
  return 4096;
}

function isReasoningByName(name: string): boolean {
  return /\b(r1|reason|think|deepseek|qwq|coder|code)\b/i.test(name);
}

function buildModel(id: string, caps: string[], modelInfo?: Record<string, unknown>): ProviderModelConfig {
  return {
    id,
    name: id,
    reasoning: caps.includes("thinking") || isReasoningByName(id),
    input: (caps.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { ...ZERO_COST },
    contextWindow: modelInfo ? getContextLength(modelInfo) : guessContextFromName(id),
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function assembleCloudModels(raw: Record<string, OllamaShowResponse>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, d]) => d.capabilities?.includes("tools"))
    .map(([id, d]) => buildModel(id, d.capabilities ?? [], d.model_info));
}

function assembleLocalModels(
  models: OllamaListModel[],
  details: Map<string, OllamaShowResponse | null>,
): ProviderModelConfig[] {
  return models.map((m) => {
    const show = details.get(m.name);
    return buildModel(m.name, show?.capabilities ?? [], show?.model_info);
  });
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function readCache(): Record<string, OllamaShowResponse> | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data: CachedData = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    return data.models && Object.keys(data.models).length > 0 ? data.models : null;
  } catch {
    return null;
  }
}

function writeCache(models: Record<string, OllamaShowResponse>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), models } satisfies CachedData, null, 2));
  } catch {
    // ignore write errors
  }
}

// ─── Fetch with timeout + external signal chaining ────────────────────────────

async function fetchT(url: string, init: RequestInit = {}, timeout = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  if (init.signal) {
    if (init.signal.aborted) {
      clearTimeout(timer);
      ctrl.abort();
    } else {
      init.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Cloud HTTP helpers ───────────────────────────────────────────────────────

function cloudHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function cloudPost<T>(
  path: string,
  body: unknown,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await fetchT(`${CLOUD_BASE}${path}`, {
    method: "POST",
    headers: cloudHeaders(apiKey),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const error = await res.text().catch(() => res.statusText);
    return { ok: false, status: res.status, error };
  }
  return { ok: true, data: (await res.json()) as T };
}

async function requireCloudKey(ctx: ExtensionContext): Promise<string | null> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud");
  return key || null;
}

// ─── Local Ollama ─────────────────────────────────────────────────────────────

async function isLocalRunning(): Promise<boolean> {
  try {
    const res = await fetchT(`${LOCAL_BASE}/api/tags`, {}, 3000);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchLocalModels(): Promise<{
  models: OllamaListModel[];
  details: Map<string, OllamaShowResponse | null>;
} | null> {
  try {
    const res = await fetchT(`${LOCAL_BASE}/api/tags`);
    if (!res.ok) return null;
    const data = (await res.json()) as OllamaListResponse;
    const models = data.models ?? [];

    const details = new Map<string, OllamaShowResponse | null>();
    await Promise.allSettled(
      models.map(async (m) => {
        try {
          const r = await fetchT(`${LOCAL_BASE}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.name }),
          });
          details.set(m.name, r.ok ? ((await r.json()) as OllamaShowResponse) : null);
        } catch {
          details.set(m.name, null);
        }
      }),
    );

    return { models, details };
  } catch {
    return null;
  }
}

// ─── Ollama Cloud ─────────────────────────────────────────────────────────────

const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "glm-5.1:cloud",
    name: "GLM 5.1 Cloud",
    reasoning: true,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 202_752,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemma4:cloud",
    name: "Gemma 4 Cloud",
    reasoning: true,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 262_144,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
];

async function fetchCloudModels(ctx: ExtensionCommandContext): Promise<Record<string, OllamaShowResponse>> {
  const apiKey = await requireCloudKey(ctx);
  if (!apiKey) {
    ctx.ui.notify(NO_KEY_MSG, "error");
    return {};
  }

  // 1. GET /v1/models
  const res = await fetchT(`${CLOUD_BASE}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
    .catch((): null => null);
  if (res === null) {
    ctx.ui.notify("Cannot reach Ollama Cloud", "error");
    return {};
  }
  if (!res.ok) {
    ctx.ui.notify(`Cloud /v1/models failed: ${res.status}`, "error");
    return {};
  }

  const list = (await res.json()) as { data: { id: string }[] };
  const ids = list.data.map((m) => m.id);
  ctx.ui.notify(`Cloud: ${ids.length} models found, fetching details...`);

  // 2. POST /api/show per model in parallel
  const results: Record<string, OllamaShowResponse> = {};
  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      const result = await cloudPost<OllamaShowResponse>("/api/show", { model: id }, apiKey);
      if (result.ok) results[id] = result.data;
    }),
  );

  const failed = settled.filter((r) => r.status === "rejected").length;
  ctx.ui.notify(
    `Cloud: ${Object.keys(results).length} model details fetched${failed ? ` (${failed} failed)` : ""}`,
    "info",
  );

  return results;
}

// ─── Tool rendering ───────────────────────────────────────────────────────────

const PREVIEW_LINES = 8;

function createRenderResult() {
  return (
    result: { content: Array<{ type: string; text: string }>; isError?: boolean },
    options: { expanded: boolean; isPartial: boolean },
    theme: import("@mariozechner/pi-coding-agent").Theme,
    context: {
      invalidate: () => void;
      lastComponent: import("@mariozechner/pi-tui").Component | undefined;
      state: { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };
    },
  ) => {
    const state = context.state;
    const output = result.content
      .map((c) => c.text)
      .join("")
      .trim();
    const styled = output.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");

    if (options.expanded || result.isError) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(result.isError ? styled : `\n${styled}`);
      return text;
    }

    return {
      render: (width: number) => {
        if (state.cachedWidth !== width) {
          const preview = truncateToVisualLines(styled, PREVIEW_LINES, width);
          state.cachedLines = preview.visualLines;
          state.cachedSkipped = preview.skippedCount;
          state.cachedWidth = width;
        }
        if (state.cachedSkipped && state.cachedSkipped > 0) {
          const hint =
            theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
          return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
        }
        return ["", ...(state.cachedLines ?? [])];
      },
      invalidate: () => {
        state.cachedWidth = undefined;
        state.cachedLines = undefined;
        state.cachedSkipped = undefined;
      },
    };
  };
}

// ─── Provider registration ───────────────────────────────────────────────────

function registerLocalProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama", {
    baseUrl: `${LOCAL_BASE}/v1`,
    apiKey: "ollama",
    api: "openai-completions",
    models,
  });
}

function registerCloudProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    baseUrl: `${CLOUD_BASE}/v1`,
    apiKey: "$OLLAMA_API_KEY",
    api: "openai-completions",
    models,
    oauth: {
      name: "Ollama Cloud",
      async login(callbacks) {
        const apiKey = await callbacks.onPrompt({ message: "Enter your Ollama Cloud API key:" });
        if (!apiKey || apiKey.trim() === "") throw new Error("API key is required");
        return {
          access: apiKey.trim(),
          refresh: "",
          expires: Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials) {
        return credentials.expires > Date.now() ? credentials : { access: "", refresh: "", expires: 0 };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
}

// ─── /ollama status ────────────────────────────────────────────────────────────

async function handleStatus(ctx: ExtensionCommandContext) {
  const [localUp, cloudKey] = await Promise.all([
    isLocalRunning(),
    ctx.modelRegistry.getApiKeyForProvider("ollama-cloud"),
  ]);

  ctx.ui.notify(
    [
      "🦙 Ollama Status",
      "",
      `Local:  ${localUp ? "✅ Connected" : "❌ Not running"}`,
      `Cloud:  ${cloudKey ? "✅ API key set" : "❌ No API key"}`,
      "",
      `Local URL:  ${LOCAL_BASE}`,
      `Cloud URL:  ${CLOUD_BASE}`,
    ].join("\n"),
    "info",
  );
}

// ─── /ollama sync ─────────────────────────────────────────────────────────────

async function handleSync(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  ctx.ui.setWorkingMessage("Syncing Ollama models...");
  const results: string[] = [];

  // Local
  if (await isLocalRunning()) {
    const local = await fetchLocalModels();
    if (local && local.models.length > 0) {
      const models = assembleLocalModels(local.models, local.details);
      registerLocalProvider(pi, models);
      results.push(`📍 Local: ${models.length} models`);
    } else {
      results.push("📍 Local: no models found");
    }
  } else {
    results.push("📍 Local: not running (skipped)");
  }

  // Cloud
  const cloudKey = await requireCloudKey(ctx);
  if (cloudKey) {
    const raw = await fetchCloudModels(ctx);
    if (Object.keys(raw).length > 0) {
      writeCache(raw);
      const models = assembleCloudModels(raw);
      registerCloudProvider(pi, models);
      results.push(`☁️  Cloud: ${models.length} tool-capable models`);
    } else {
      results.push("☁️  Cloud: fetch failed (keeping cached models)");
    }
  } else {
    results.push("☁️  Cloud: no API key (skipped)");
  }

  ctx.ui.notify(`🦙 Synced\n${results.join("\n")}`, "info");
  ctx.ui.setWorkingMessage();
}

// ─── Web tools ────────────────────────────────────────────────────────────────

const NO_KEY_ERROR = {
  content: [{ type: "text" as const, text: `Error: ${NO_KEY_MSG}` }],
  isError: true,
};

function registerWebTools(pi: ExtensionAPI) {
  const renderResult = createRenderResult();

  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud. " +
      "Returns titles, URLs, and content snippets. Requires OLLAMA_API_KEY.",
    promptSnippet: "Search the web via Ollama Cloud",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Number({ description: "Max results (1-10, default 5)", default: 5 })),
    }),
    async execute(_, params, signal, _onUpdate, ctx) {
      const apiKey = await requireCloudKey(ctx);
      if (!apiKey) return NO_KEY_ERROR;

      const result = await cloudPost<{ results: Array<{ title: string; url: string; content: string }> }>(
        "/api/web_search",
        { query: params.query, max_results: params.max_results ?? 5 },
        apiKey,
        signal,
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `Search error (${result.status}): ${result.error}` }], isError: true };
      }

      const formatted = result.data.results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: formatted || "No results found." }],
        details: { results: result.data.results },
      };
    },
    renderResult,
  });

  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text from a web page URL using Ollama Cloud. " +
      "Returns title, content, and links. Requires OLLAMA_API_KEY.",
    promptSnippet: "Fetch a web page via Ollama Cloud",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    async execute(_, params, signal, _onUpdate, ctx) {
      const apiKey = await requireCloudKey(ctx);
      if (!apiKey) return NO_KEY_ERROR;

      const result = await cloudPost<{ title: string; content: string; links: string[] }>(
        "/api/web_fetch",
        { url: params.url },
        apiKey,
        signal,
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `Fetch error (${result.status}): ${result.error}` }], isError: true };
      }

      const { title, content, links } = result.data;
      const formatted = [
        `Title: ${title}`,
        "",
        "Content:",
        content,
        "",
        `Links: ${links?.length ?? 0}`,
        ...(links?.slice(0, 10).map((l) => `  - ${l}`) ?? []),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
        details: { title, content, links },
      };
    },
    renderResult,
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export default async function(pi: ExtensionAPI) {
  // Boot: cloud from cache or fallback
  const cached = readCache();
  registerCloudProvider(pi, cached ? assembleCloudModels(cached) : FALLBACK_MODELS);

  // Boot: try local discovery
  if (await isLocalRunning()) {
    const local = await fetchLocalModels();
    if (local && local.models.length > 0) {
      registerLocalProvider(pi, assembleLocalModels(local.models, local.details));
    }
  }

  // Command: /ollama
  pi.registerCommand("ollama", {
    description: "Ollama management (status | sync)",
    getArgumentCompletions(prefix: string) {
      const subs = ["status", "sync"];
      const filtered = subs.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub] = args.trim().split(/\s+/);
      switch (sub) {
        case "status":
          return handleStatus(ctx);
        case "sync":
          return handleSync(pi, ctx);
        default:
          ctx.ui.notify(
            ["🦙 /ollama commands:", "", "  status  — Connection status (local + cloud)", "  sync    — Refresh model list"].join("\n"),
            "info",
          );
      }
    },
  });

  // Web tools (cloud-only)
  registerWebTools(pi);
}
