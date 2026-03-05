import {
  buildOauthProviderAuthResult,
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk/outlier-playground";
import { startProxy, validateSession, fetchModelIdMap, type OutlierSession } from "./proxy.js";

const PROVIDER_ID = "outlier-playground";
const PROVIDER_LABEL = "Outlier Playground";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const OUTLIER_LOGIN_URL = "https://playground.outlier.ai/";

// Models available on Outlier Playground — modelKey values from /playground-models API.
// Only text-capable base models (no Audio/Voice/Realtime variants).
const MODELS = [
  // Anthropic
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", reasoning: true },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", reasoning: true },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true },
  { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1", reasoning: true },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", reasoning: false },
  // OpenAI
  { id: "gpt-5.2-chat-latest", name: "GPT-5.2", reasoning: false },
  { id: "gpt-5.1-chat-latest", name: "GPT-5.1", reasoning: false },
  { id: "gpt-5.2-2025-12-11", name: "GPT 5.2 (Thinking)", reasoning: true },
  { id: "gpt-5.1-2025-11-13", name: "GPT 5.1 (Thinking)", reasoning: true },
  { id: "o3", name: "o3", reasoning: true },
  { id: "o4-mini", name: "o4-mini", reasoning: true },
  // Google
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", reasoning: true },
  { id: "gemini-3-pro-preview", name: "Gemini 3 Pro", reasoning: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true },
  // xAI
  { id: "grok-4-1-fast-reasoning", name: "Grok 4.1 Fast (Reasoning)", reasoning: true },
  { id: "grok-4-1-fast-non-reasoning", name: "Grok 4.1 Fast (Non-Reasoning)", reasoning: false },
  { id: "Grok 4", name: "Grok 4", reasoning: true },
  // DeepSeek
  { id: "deepseek-r1-0528", name: "DeepSeek R1", reasoning: true },
  { id: "deepseek-v3p2", name: "DeepSeek v3.2", reasoning: false },
  // Moonshot
  { id: "kimi-k2-thinking", name: "Kimi K2", reasoning: true },
  { id: "kimi-k2p5", name: "Kimi K2.5", reasoning: true },
] as const;

const DEFAULT_MODEL_REF = `${PROVIDER_ID}/claude-sonnet-4-6`;

function buildModelDefinition(model: (typeof MODELS)[number]) {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions" as const,
    reasoning: model.reasoning,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

// Track the running proxy so we don't start multiple
let activeProxy: { port: number; close: () => void } | null = null;

const outlierPlaygroundPlugin = {
  id: "outlier-playground",
  name: "Outlier Playground",
  description: "Use Outlier Playground models (Claude, GPT, Gemini, Grok, etc.) via session auth",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["outlier"],
      auth: [
        {
          id: "session",
          label: "Browser session",
          hint: "Log in via browser, then paste session cookies",
          kind: "custom",
          run: async (ctx: ProviderAuthContext) => {
            // Step 1: Guide login
            await ctx.prompter.note(
              [
                "Outlier Playground uses browser session authentication.",
                "",
                "Steps:",
                "1. A browser will open to playground.outlier.ai",
                "2. Log in with your Outlier account",
                "3. Once logged in, open DevTools (F12)",
                "4. Go to Network tab, find any request to playground.outlier.ai",
                "5. Right-click the request → Copy → Copy as cURL",
                "6. Come back here and paste it",
                "",
                "We'll extract the session cookies automatically.",
              ].join("\n"),
              "Outlier Playground Setup",
            );

            await ctx.openUrl(OUTLIER_LOGIN_URL);

            // Step 2: Get cURL or cookies from user
            const input = String(
              await ctx.prompter.text({
                message: "Paste the cURL command (or raw Cookie header value)",
                validate: (value: string) => {
                  const v = value?.trim();
                  if (!v) return "Required";
                  return undefined;
                },
              }),
            ).trim();

            const session = parseCurlOrCookies(input);
            if (!session.cookies) {
              throw new Error(
                "Could not extract cookies from the input. Please copy the cURL command from DevTools.",
              );
            }

            // Step 3: Validate the session
            const spin = ctx.prompter.progress("Validating session…");
            const valid = await validateSession(session);
            if (!valid) {
              spin.stop("Session validation failed");
              throw new Error(
                "Session cookies appear invalid or expired. Please log in again and re-copy.",
              );
            }
            spin.update("Fetching model catalog…");

            // Fetch the model ID mapping from the API
            await fetchModelIdMap(session);

            spin.update("Starting local proxy…");

            // Step 4: Start the local proxy
            if (activeProxy) {
              activeProxy.close();
            }
            activeProxy = await startProxy(session);
            const baseUrl = `http://127.0.0.1:${activeProxy.port}/v1`;
            spin.stop(`Proxy running on port ${activeProxy.port}`);

            // Step 5: Return provider config
            return {
              profiles: [
                {
                  profileId: "outlier-playground:session",
                  credential: {
                    type: "token" as const,
                    provider: PROVIDER_ID,
                    token: JSON.stringify(session),
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey: "outlier-session",
                      api: "openai-completions",
                      authHeader: false,
                      models: MODELS.map(buildModelDefinition),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      MODELS.map((m) => [`${PROVIDER_ID}/${m.id}`, {}]),
                    ),
                  },
                },
              },
              defaultModel: DEFAULT_MODEL_REF,
              notes: [
                "Outlier Playground session cookies expire. Re-run auth if requests start failing.",
                `Local proxy is running on port ${activeProxy.port}.`,
                "All models are free (cost $0) — they're an Outlier contributor perk.",
              ],
            };
          },
        },
      ],
    });
  },
};

/**
 * Parse a cURL command or raw cookie string to extract session cookies and CSRF token.
 */
function parseCurlOrCookies(input: string): OutlierSession {
  let cookies = "";
  let csrfToken = "";

  // Try parsing as cURL command
  const cookieMatch = input.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i);
  if (cookieMatch) {
    cookies = cookieMatch[1].trim();
  }

  const csrfMatch = input.match(/-H\s+['"]x-csrf-token:\s*([^'"]+)['"]/i);
  if (csrfMatch) {
    csrfToken = csrfMatch[1].trim();
  }

  // If not a cURL command, treat as raw cookie string
  if (!cookies && !input.startsWith("curl")) {
    cookies = input;
  }

  // Try to extract CSRF from cookies if not found in headers
  if (!csrfToken) {
    const csrfCookieMatch = cookies.match(/(?:^|;\s*)_csrf=([^;]+)/);
    if (csrfCookieMatch) {
      csrfToken = csrfCookieMatch[1];
    }
  }

  return { cookies, csrfToken };
}

export default outlierPlaygroundPlugin;
