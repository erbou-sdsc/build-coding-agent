/**
 * SDSC LLM Provider Extension
 *
 * ~/.pi/agent/auth.json instead.
 *
 * Usage:
 *   pi -e ./sdsc-llm
 *   # Then /login sdsc-llm to authenticate (device code flow)
 *   # Then /model to select gemma-4 or qwen3.6
 */

import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs"


// =============================================================================
// OIDC Configuration (mirrors ocli-login.py)
// =============================================================================

const OIDC_ISSUER_URL =
  "https://authentik-server-runai-sharedllm-ralf.inference.compute.datascience.ch/application/o/vllm/";
const OIDC_CLIENT_ID = "P8dW2vrNPDa8d43qd4BK49eEDYJFtvYk";
const OIDC_SCOPES = ["openid", "profile", "email"];
const TOKEN_PATH = "/secrets/sdsc_llm_token.txt"

// vLLM gateway endpoint
const VLLM_BASE_URL =
  "https://vllm-gateway-runai-sharedllm-ralf.inference.compute.datascience.ch/v1";

// =============================================================================
// OIDC Discovery
// =============================================================================

interface OidcConfiguration {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  authorization_endpoint: string;
}

let cachedOidcConfig: OidcConfiguration | null = null;

async function discoverOidc(): Promise<OidcConfiguration> {
  if (cachedOidcConfig) return cachedOidcConfig;

  // Try OIDC discovery first
  try {
    const discoveryUrl = `${OIDC_ISSUER_URL}.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl);
    if (response.ok) {
      const config = (await response.json()) as OidcConfiguration;
      cachedOidcConfig = config;
      return config;
    }
  } catch {
    // Discovery failed, fall back to inferred endpoints
  }

  // Fall back to inferred endpoints for Authentik
  cachedOidcConfig = {
    issuer: OIDC_ISSUER_URL,
    device_authorization_endpoint: `${OIDC_ISSUER_URL}device/`,
    token_endpoint: `${OIDC_ISSUER_URL}token/`,
    authorization_endpoint: `${OIDC_ISSUER_URL}authorize/`,
  };
  return cachedOidcConfig;
}

// =============================================================================
// Device Code Flow (mirrors pyocli.start_device_code_flow + finish_device_code_flow)
// =============================================================================

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

async function startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
  const config = await discoverOidc();

  const response = await fetch(config.device_authorization_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OIDC_CLIENT_ID,
      scope: OIDC_SCOPES.join(" "),
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Device authorization failed (${response.status}): ${errorText}`
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

async function finishDeviceCodeFlow(
  deviceCode: DeviceCodeResponse
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const config = await discoverOidc();

  const pollInterval = deviceCode.interval * 1000;
  const expiresIn = deviceCode.expires_in * 1000;
  const deadline = Date.now() + expiresIn;

  while (Date.now() < deadline) {
    const response = await fetch(config.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OIDC_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode.device_code,
      }).toString(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = errorData.error || "";

      if (error === "authorization_pending") {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        continue;
      }
      if (error === "slow_down") {
        await new Promise((resolve) =>
          setTimeout(resolve, pollInterval + 5000)
        );
        continue;
      }
      if (error === "expired_token") {
        throw new Error(
          "Device code expired. Please try logging in again."
        );
      }
      const errorText = await response.text();
      throw new Error(
        `Token exchange failed (${response.status}): ${errorText}`
      );
    }

    return (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
  }

  throw new Error("Device code expired. Please try logging in again.");
}

// =============================================================================
// OAuth Login / Refresh
// =============================================================================

async function loginSdscLlm(
  callbacks: OAuthLoginCallbacks
): Promise<OAuthCredentials> {
  console.log("Starting SDSC LLM device code flow...");

  const deviceCode = await startDeviceCodeFlow();

  // Show verification URL (prefer complete URL if available)
  const displayUrl =
    deviceCode.verification_uri_complete ?? deviceCode.verification_uri;
  console.log(
    `Please navigate to: ${displayUrl}`
  );
  console.log(`And enter the user code: ${deviceCode.user_code}`);

  // Use onAuth to display the verification URL and user code
  callbacks.onAuth({
    url: displayUrl,
    instructions: `Enter the user code: ${deviceCode.user_code}`,
  });

  // Finish the flow and get tokens
  const tokens = await finishDeviceCodeFlow(deviceCode);

  console.log("Successfully obtained access token");

  return {
    refresh: tokens.refresh_token ?? "",
    access: tokens.access_token,
    expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000, // 5 min buffer
  };
}

async function refreshSdscLlmToken(
  credentials: OAuthCredentials
): Promise<OAuthCredentials> {
  const config = await discoverOidc();

  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OIDC_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      scope: OIDC_SCOPES.join(" "),
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    refresh: data.refresh_token ?? credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// =============================================================================
// Stream Function
// =============================================================================

export function streamSdscLlm(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    try {
      // Get the access token from options (set by pi's OAuth system)
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error(
          "No access token. Run /login sdsc-llm to authenticate."
        );
      }

      // Build the model config with custom auth headers
      const modelWithHeaders: Model<Api> = {
        ...model,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      };

      // Delegate to the built-in OpenAI completions stream
      const innerStream = streamSimpleOpenAICompletions(
        modelWithHeaders,
        context,
        options
      );

      // Forward all events from the inner stream
      for await (const event of innerStream) {
        stream.push(event);
      }
      stream.end();
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      });
      stream.end();
    }
  })();

  return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================
function getSdscLlmToken(): string {
  try {
    const value = readFileSync(TOKEN_PATH, "utf8").trim()
    if (!value) return undefined // SDSC_LLM_TOKEN
    return value
  } catch {
    return undefined
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("sdsc-llm", {
    name: "SDSC LLM",
    baseUrl: VLLM_BASE_URL,
    apiKey: getSdscLlmToken(), // env var fallback (optional, OAuth takes precedence)
    api: "openai-completions",
    models: [
      {
        id: "google/gemma-4-26B-A4B-it",
        name: "Gemma 4 26B",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 32768,
      },
      {
        id: "Qwen/Qwen3.6-35B-A3B-FP8",
        name: "Qwen 3.6 35B",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          thinkingFormat: "qwen",
        },
      },
    ],
    oauth: {
      name: "SDSC LLM (OIDC)",
      login: loginSdscLlm,
      refreshToken: refreshSdscLlmToken,
      getApiKey: (cred) => cred.access,
    },
    streamSimple: streamSdscLlm,
  });
}
