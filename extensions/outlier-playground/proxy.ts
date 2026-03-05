import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const OUTLIER_BASE = "https://playground.outlier.ai";
const CONVERSATIONS_URL = `${OUTLIER_BASE}/internal/experts/assistant/conversations`;
const PLAYGROUND_MODELS_URL = `${OUTLIER_BASE}/internal/experts/assistant/playground-models`;

// Default system message Outlier uses
const DEFAULT_SYSTEM_MESSAGE =
  "You are a helpful chat assistant. You are part of a product called the Model Playground, " +
  "in which users can chat with various models from leading LLM providers in the Generative AI space. " +
  "The Model Playground is a perk for contributors on Outlier, a platform that connects subject matter " +
  "experts to help build the world's most advanced Generative AI.";

export type OutlierSession = {
  cookies: string;
  csrfToken: string;
};

// modelKey → modelId mapping, fetched dynamically from playground-models endpoint
let modelIdMap: Map<string, string> | null = null;

type OutlierModel = {
  id: string;
  modelKey: string;
  displayName: string;
  variant: string | null;
  modelThinkingType: string;
};

/** Fetch the playground-models list and build modelKey→id map. */
export async function fetchModelIdMap(session: OutlierSession): Promise<Map<string, string>> {
  if (modelIdMap) return modelIdMap;

  const res = await fetch(PLAYGROUND_MODELS_URL, {
    headers: buildHeaders(session),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch playground-models: ${res.status}`);
  }
  const models = (await res.json()) as OutlierModel[];
  modelIdMap = new Map();
  for (const m of models) {
    modelIdMap.set(m.modelKey, m.id);
  }
  return modelIdMap;
}

/** Resolve a model name to its Outlier modelId. Handles thinking variant lookup. */
function resolveModelId(model: string): string | undefined {
  if (!modelIdMap) return undefined;
  // Direct match
  const direct = modelIdMap.get(model);
  if (direct) return direct;
  // Try without thinking suffix for thinking models
  return undefined;
}

/** Validate that stored session cookies still work. */
export async function validateSession(session: OutlierSession): Promise<boolean> {
  try {
    const res = await fetch(`${OUTLIER_BASE}/internal/experts/assistant/allowed`, {
      headers: buildHeaders(session),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { allowed?: boolean };
    return data.allowed === true;
  } catch {
    return false;
  }
}

function buildHeaders(session: OutlierSession): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: session.cookies,
    "x-csrf-token": session.csrfToken,
    origin: OUTLIER_BASE,
    referer: `${OUTLIER_BASE}/`,
  };
}

/** Create a new Outlier conversation and return its ID. */
async function createConversation(
  session: OutlierSession,
  opts: { text: string; model: string; modelId: string; enableThinking: boolean },
): Promise<string> {
  const body = {
    prompt: { text: opts.text, images: [] },
    model: opts.model,
    modelId: opts.modelId,
    challengeId: "",
    initialTurnType: "Text",
    isMysteryModel: false,
  };
  const res = await fetch(CONVERSATIONS_URL, {
    method: "POST",
    headers: buildHeaders(session),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create Outlier conversation: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id?: string; _id?: string };
  const id = data.id ?? data._id;
  if (!id) throw new Error("Outlier returned no conversation ID");
  return id;
}

type OpenAIMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
};

type ChatCompletionRequest = {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
};

/**
 * Flatten an OpenAI messages array into { systemMessage, text } for Outlier.
 * Takes the system message and concatenates conversation history into the text field.
 */
function flattenMessages(messages: OpenAIMessage[]): { systemMessage: string; text: string } {
  let systemMessage = DEFAULT_SYSTEM_MESSAGE;
  const parts: string[] = [];

  for (const msg of messages) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("");

    if (msg.role === "system") {
      systemMessage = content;
    } else if (msg.role === "user") {
      parts.push(content);
    } else if (msg.role === "assistant") {
      parts.push(`[Assistant]: ${content}`);
    }
  }

  // For single-turn: just the last user message.
  // For multi-turn: include formatted history.
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length <= 1) {
    return { systemMessage, text: parts[parts.length - 1] ?? "" };
  }

  return { systemMessage, text: parts.join("\n\n") };
}

/** Determine if the model likely has extended thinking enabled. */
function shouldEnableThinking(model: string): boolean {
  // Models with known thinking support
  const thinkingModels = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "o3",
    "o3-pro",
    "o1",
    "o4-mini",
    "o3 mini",
    "o1 mini",
    "deepseek-r1",
    "deepseek-v3p2-thinking",
    "kimi-k2-thinking",
    "qwen3",
  ];
  const lowerModel = model.toLowerCase();
  return thinkingModels.some((m) => lowerModel.includes(m.toLowerCase()));
}

/**
 * Forward a chat completion request to Outlier's turn-streaming API.
 * Pipes the SSE response directly since Outlier already returns OpenAI-compatible chunks.
 */
async function handleChatCompletion(
  session: OutlierSession,
  body: ChatCompletionRequest,
  res: ServerResponse,
): Promise<void> {
  const { systemMessage, text } = flattenMessages(body.messages);
  const model = body.model;
  const enableThinking = shouldEnableThinking(model);
  const modelId = resolveModelId(model) ?? "";

  // Create a fresh conversation for each request
  const conversationId = await createConversation(session, { text, model, modelId, enableThinking });

  const turnBody = {
    prompt: {
      model,
      turnType: "Text",
      modelId,
      text,
      images: [],
      enableThinking,
      systemMessage,
      modelWasSwitched: false,
      isMysteryModel: false,
    },
    model,
    modelId,
    systemMessage,
    parentIdx: -1,
    turnType: "Text",
    isMysteryModel: false,
  };

  const outlierRes = await fetch(
    `${CONVERSATIONS_URL}/${encodeURIComponent(conversationId)}/turn-streaming`,
    {
      method: "POST",
      headers: {
        ...buildHeaders(session),
        accept: "text/event-stream",
      },
      body: JSON.stringify(turnBody),
    },
  );

  if (!outlierRes.ok) {
    const errText = await outlierRes.text();
    res.writeHead(outlierRes.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Outlier API error: ${errText}`, type: "api_error" } }));
    return;
  }

  // Stream the response directly — Outlier already uses OpenAI SSE format
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const reader = outlierRes.body?.getReader();
  if (!reader) {
    res.end("data: [DONE]\n\n");
    return;
  }

  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Connection closed
  } finally {
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the local Outlier proxy server.
 * Translates OpenAI /v1/chat/completions → Outlier turn-streaming API.
 */
export function startProxy(session: OutlierSession): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");

      // Health check
      if (url.pathname === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }

      // Chat completions
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as ChatCompletionRequest;
          await handleChatCompletion(session, body, res);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: String(err), type: "server_error" },
              }),
            );
          }
        }
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
    });

    server.once("error", reject);
    // Listen on random available port on loopback
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });
  });
}
