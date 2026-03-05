#!/usr/bin/env bun
/**
 * Standalone test: validates Outlier Playground session + proxy end-to-end.
 *
 * Usage:
 *   1. Log in to https://playground.outlier.ai/ in your browser
 *   2. Open DevTools → Network tab → find any request to playground.outlier.ai
 *   3. Right-click → Copy as cURL
 *   4. Run: bun extensions/outlier-playground/test-outlier.ts
 *   5. Paste the cURL when prompted (or set OUTLIER_COOKIES + OUTLIER_CSRF env vars)
 */

import * as readline from "node:readline";
import { startProxy, validateSession, fetchModelIdMap, type OutlierSession } from "./proxy.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function parseCurlOrCookies(input: string): OutlierSession {
  let cookies = "";
  let csrfToken = "";

  const cookieMatch = input.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i);
  if (cookieMatch) cookies = cookieMatch[1].trim();

  const csrfMatch = input.match(/-H\s+['"]x-csrf-token:\s*([^'"]+)['"]/i);
  if (csrfMatch) csrfToken = csrfMatch[1].trim();

  if (!cookies && !input.startsWith("curl")) {
    cookies = input;
  }

  if (!csrfToken) {
    const csrfCookieMatch = cookies.match(/(?:^|;\s*)_csrf=([^;]+)/);
    if (csrfCookieMatch) csrfToken = csrfCookieMatch[1];
  }

  return { cookies, csrfToken };
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Outlier Playground API Test ===\n");

  // Get session from env or prompt
  let session: OutlierSession;
  if (process.env.OUTLIER_COOKIES) {
    session = {
      cookies: process.env.OUTLIER_COOKIES,
      csrfToken: process.env.OUTLIER_CSRF ?? "",
    };
    console.log("Using session from environment variables.");
  } else {
    console.log("Paste a cURL command from DevTools (copy any playground.outlier.ai request):");
    console.log("(paste and press Enter)\n");
    const input = await ask("> ");
    session = parseCurlOrCookies(input);
  }

  if (!session.cookies) {
    console.error("ERROR: No cookies found. Please copy a cURL command from DevTools.");
    process.exit(1);
  }

  console.log(`\nCookies: ${session.cookies.substring(0, 60)}...`);
  console.log(`CSRF token: ${session.csrfToken || "(none — will try without)"}\n`);

  // Test 1: Validate session
  console.log("── Test 1: Validate session ──");
  const valid = await validateSession(session);
  console.log(`Session valid: ${valid}`);
  if (!valid) {
    console.error("Session is invalid or expired. Please log in again.");
    process.exit(1);
  }
  console.log("✓ Session is valid\n");

  // Test 2: Fetch model ID catalog
  console.log("── Test 2: Fetch model ID catalog ──");
  const modelMap = await fetchModelIdMap(session);
  console.log(`✓ Loaded ${modelMap.size} model entries`);
  const sonnetId = modelMap.get("claude-sonnet-4-6");
  console.log(`  claude-sonnet-4-6 → ${sonnetId ?? "(not found)"}\n`);

  // Test 3: Start proxy
  console.log("── Test 3: Start local proxy ──");
  const proxy = await startProxy(session);
  console.log(`✓ Proxy running on http://127.0.0.1:${proxy.port}/v1\n`);

  // Test 4: Hit /v1/models
  console.log("── Test 4: GET /v1/models ──");
  const modelsRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
  console.log(`Status: ${modelsRes.status}`);
  const modelsData = await modelsRes.json();
  console.log(`Response: ${JSON.stringify(modelsData).substring(0, 200)}`);
  console.log("✓ Models endpoint works\n");

  // Test 5: Chat completion (streaming)
  console.log("── Test 5: POST /v1/chat/completions (streaming) ──");
  console.log("Sending: 'Say hello in exactly 5 words.' with claude-sonnet-4-6\n");

  const chatRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Say hello in exactly 5 words." }],
      stream: true,
    }),
  });

  console.log(`Status: ${chatRes.status}`);
  if (!chatRes.ok) {
    const errText = await chatRes.text();
    console.error(`ERROR: ${errText}`);
    proxy.close();
    process.exit(1);
  }

  // Read streaming response
  const reader = chatRes.body?.getReader();
  if (!reader) {
    console.error("ERROR: No response body");
    proxy.close();
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let fullContent = "";
  let chunkCount = 0;

  console.log("Streaming response:");
  process.stderr.write("  ");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));

    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;

      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
          process.stderr.write(delta.content);
        }
        if (delta?.reasoning_content) {
          process.stderr.write(`[think: ${delta.reasoning_content}]`);
        }
        chunkCount++;
      } catch {
        // Skip unparseable chunks
      }
    }
  }

  console.log(`\n\nFull content: "${fullContent}"`);
  console.log(`Chunks received: ${chunkCount}`);
  console.log("✓ Streaming chat completion works\n");

  // Cleanup
  proxy.close();
  console.log("=== All tests passed ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
