// pi provider extension: xAI Grok models via Google Cloud Vertex AI Model Garden.
//
// Grok-on-Vertex (launched 2026-08-21) speaks the OpenAI-completions protocol, unlike pi's
// built-in "xai" provider (native xAI API, needs XAI_API_KEY) and pi's built-in "google-vertex"
// provider (built for Gemini's own native Vertex API shape, not OpenAI-compatible). Neither
// covers this case, so it needs its own provider registration — this is NOT related to
// @twogiants/pi-anthropic-vertex, which is tightly coupled to Anthropic's own message/streaming
// format; bridging a different protocol needs its own bridge.
//
// Prior art in other ecosystems (not drop-in for pi, but the same idea and worth reading before
// changing anything here): vercel/ai's packages/google-vertex/src/xai (AI SDK, LanguageModelV4)
// and TanStack/ai's packages/ai-grok/src/vertex. Both mint a Google access token per request via
// google-auth-library, which is exactly the shape below. As of 2026-08-24 nothing pi-shaped
// exists and earendil-works/pi has no open issue or PR for xai-on-Vertex, so unlike
// anthropic-vertex (tracked against upstream pi#5262) there is no upstream to wait for.
//
// Endpoint shape confirmed empirically 2026-08-24: the model is only served on the *global*
// Vertex endpoint (regional endpoints return a 400 FAILED_PRECONDITION telling you to use global),
// so this hardcodes "global" rather than reading GOOGLE_CLOUD_LOCATION/CLOUD_ML_REGION — that's a
// real technical constraint of this specific model, not a configuration preference. Both
// implementations above default to "global" too.
//
// Auth: Vertex requires a short-lived (~1hr) OAuth2 access token minted from Application Default
// Credentials, not a static API key. ADC is *ambient* — discovered from the environment, with
// nothing for a user to type — so this registers `auth.apiKey` with **no `login` handler**, which is
// how pi spells "ambient-only", and pi calls `resolve()` per request. Do NOT switch this to
// `auth.oauth`: that shape means "an interactive login mints a credential pi persists to
// ~/.pi/agent/auth.json", so pi refuses the provider until one exists. It shipped that way in v0.1.0
// and looked fine on any machine that had logged in once, while failing on every fresh environment
// with "No API key found for xai-vertex".
//
// Token minting uses the Node google-auth-library (declared in this directory's package.json)
// rather than shelling out to python3's google.auth: it is the same library the Claude-on-Vertex
// path already depends on, it needs no child_process on the credential path, it is the only one
// proven against the rewritten external_account config that fullsend's
// prepare-sandbox-credentials.sh hands a sandbox, and it does its own token caching and renewal —
// which is why there is no expiry arithmetic here.
//
// The GCP project comes from an env var and is never hardcoded here: it is deployment-specific
// config, and this source is public.

// pi's extension loader resolves a fixed allowlist of specifiers to bundled virtual modules
// (core/extensions/loader.ts): "@earendil-works/pi-ai" (aliased to the compat entrypoint),
// ".../compat", ".../oauth", ".../providers/all", and "@earendil-works/pi-coding-agent". Anything
// else — including a real subpath like ".../api/openai-completions.lazy" — falls through to
// filesystem resolution, where the loader appends it to the alias *file* path and fails with
// "Cannot find module .../dist/compat.js/api/openai-completions.lazy". Import only from the
// allowlisted specifiers.
//
// openAICompletionsApi is not declared on the package root's types, so it comes from "/compat",
// which is allowlisted and re-exports it. createProvider and the types come from the root, whose
// declarations are the accurate ones.
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { AuthResult, Model, ModelCost, ProviderStreams } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleAuth } from "google-auth-library";

/** Env vars consulted for the GCP project, in precedence order. */
export const PROJECT_ENV_VARS = [
  "XAI_VERTEX_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_VERTEX_PROJECT_ID",
] as const;

/** First non-empty project id in PROJECT_ENV_VARS order, or undefined if none is set. */
export function resolveProject(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROJECT_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Grok-on-Vertex is served only on the *global* endpoint — regional ones answer
 * `400 FAILED_PRECONDITION: ... is only available via global endpoint`. That is a property of the
 * model, not a preference, so the location is deliberately not configurable.
 */
export function buildBaseUrl(project: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi`;
}

// AuthResult, Model and ModelCost are imported from pi rather than re-declared locally. A
// hand-rolled equivalent is subtly non-assignable, which forces a cast at the createProvider() call
// — and that cast would switch off the one compile-time check that catches a provider or model
// entry pi can no longer accept. Keep these bound to pi's own types so a pi upgrade fails
// `npm run lint` here instead of throwing at model resolution in production.
//
// Token lifetime is deliberately not tracked here: google-auth-library caches the access token and
// re-mints it when it ages out, and pi calls resolve() per request, so there is no expiry
// arithmetic to get wrong.

/**
 * Turn what google-auth-library returned into pi's request auth. Vertex takes the access token as a
 * bearer token, which pi sends as the `apiKey`.
 */
export function authResultFrom(token: string | null | undefined): AuthResult {
  if (!token) {
    throw new Error(
      "xai-vertex: Google ADC returned no access token. Run `gcloud auth application-default login`, " +
        "or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
    );
  }
  return { auth: { apiKey: token }, source: "Google ADC" };
}

/**
 * Published xAI rates per million tokens (docs.x.ai/docs/models, read 2026-08-24).
 *
 * xAI bills long context request-wide — "requests whose prompt reaches the listed token threshold
 * are billed at the higher rate for all tokens in the request" — which is exactly pi's tier
 * semantics ("the highest matching input threshold applies to the full request"), so this maps 1:1
 * rather than needing per-token splitting. On xAI's own API, Grok has no cache-*write* charge:
 * caching is automatic and only reads are priced.
 *
 * `cacheRead` is kept only because the endpoint occasionally reports non-zero `cached_tokens`, not
 * because caching is supported: it is unsupported (preview offering) for Grok 4.6 on Vertex AI, per
 * Google Cloud support. See the "Prompt caching" section in README.md.
 */
export const GROK_4_6_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  cacheWrite: 0,
  tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
} satisfies ModelCost;

export const PROVIDER_ID = "xai-vertex";
/**
 * The id is both pi's registry key and the value sent on the wire (there is no separate wire-name
 * field), so the slash is load-bearing: Vertex expects the publisher-qualified `xai/grok-4.6`.
 */
export const MODEL_ID = "xai/grok-4.6";

/**
 * A `data:` line whose payload is comment-shaped (starts with `:`), the form Vertex uses for its
 * keepalive frames. Matched on the payload's leading colon rather than the word `keepalive` (issue
 * #5's rule): a JSON payload or the `[DONE]` sentinel never starts with `:`, so this drops nothing
 * legitimate, and it keeps working if Vertex renames the frame (`: ping`, `: keep-alive 42`).
 */
const COMMENT_SHAPED_DATA_LINE = /^data:\s*:/;

/**
 * Creates a TransformStream that filters Vertex AI keepalive frames out of an SSE body.
 *
 * The Vertex partner-model endpoint sends keepalives as `data: : keepalive` — an SSE *data* event
 * whose payload is `: keepalive`. The OpenAI SDK's SSE decoder drops SSE comment lines
 * (`: keepalive`) but JSON.parse()s every `data:` payload, so these keepalives abort the stream
 * with "Unexpected token ':'". This transform works one SSE event at a time: comment-shaped
 * `data:` lines are removed, and an event left with no `data:` line at all is dropped whole — its
 * other field lines and its terminating blank line included, since an event without data would
 * make the decoder parse an empty payload. Everything else passes through byte for byte, each
 * line with its own terminator (`\r\n`, `\r` or `\n`), whatever the chunking. Written for a
 * trusted SSE source: an event is buffered until its blank line arrives, and one terminator style
 * per event is assumed (removing a line makes two terminators adjacent, and the SDK only splits
 * events on a doubled `\n`, `\r` or `\r\n`). Vertex sends the keepalive as a standalone,
 * `\n`-terminated event (captured 2026-09-04).
 */
export function createKeepaliveFilterTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // The current event's lines (terminators included) minus any comment-shaped data lines, and
  // whether one of those was removed from it.
  let eventLines: string[] = [];
  let droppedKeepalive = false;

  const endEvent = (controller: TransformStreamDefaultController<Uint8Array>, blankLine: string) => {
    const hasData = eventLines.some((line) => line.startsWith("data:"));
    if (hasData || !droppedKeepalive) {
      controller.enqueue(encoder.encode(eventLines.join("") + blankLine));
    }
    eventLines = [];
    droppedKeepalive = false;
  };

  const handleLine = (controller: TransformStreamDefaultController<Uint8Array>, line: string, terminator: string) => {
    if (line === "") {
      endEvent(controller, terminator);
    } else if (COMMENT_SHAPED_DATA_LINE.test(line)) {
      droppedKeepalive = true;
    } else {
      eventLines.push(line + terminator);
    }
  };

  const drain = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    // SSE line terminators, the three the OpenAI SDK's own LineDecoder accepts. A fresh regex per
    // drain, so no `lastIndex` is shared between transforms.
    const terminator = /\r\n|\r|\n/g;
    let start = 0;
    for (let match = terminator.exec(buffer); match !== null; match = terminator.exec(buffer)) {
      const end = match.index + match[0].length;
      // A lone `\r` at the very end may be the first half of a `\r\n` split across chunks.
      if (!final && match[0] === "\r" && end === buffer.length) break;
      handleLine(controller, buffer.slice(start, match.index), match[0]);
      start = end;
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer.length > 0) handleLine(controller, buffer, "");
      buffer = "";
      // A stream that ends mid-event: finish the event as if its blank line had arrived, minus
      // the blank line, so the same drop rule applies.
      if (eventLines.length > 0 || droppedKeepalive) endEvent(controller, "");
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller, false);
    },
    flush(controller) {
      buffer += decoder.decode();
      drain(controller, true);
    },
  });
}

/**
 * Wraps a fetch so that `text/event-stream` responses are filtered through
 * {@link createKeepaliveFilterTransform}. Every other response is returned untouched. The base
 * fetch is resolved per call, so a fetch pi installs after this extension loads is still the one
 * used. The rebuilt Response keeps status, statusText and headers (minus the length and encoding of
 * the original body); `url`, `redirected` and `type` cannot be set on a constructed Response, and
 * the OpenAI SDK reads `url` only for debug logging.
 */
export function createKeepaliveFilteringFetch(baseFetch?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await (baseFetch ?? globalThis.fetch)(input, init);
    // Vertex answers a streamed completion with `content-type: text/event-stream` (captured
    // 2026-09-04: no charset, HTTP/2, no content-length). Anything else — a JSON error body, say —
    // is returned untouched.
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.body || mediaType !== "text/event-stream") return response;
    // The filtered body is shorter than the original and no longer framed or encoded the way the
    // wire was.
    const headers = new Headers(response.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
    return new Response(response.body.pipeThrough(createKeepaliveFilterTransform()), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * The openai-completions API with the keepalive filter composed onto every stream call's fetch —
 * on top of a caller-supplied `options.fetch` when there is one, on `globalThis.fetch` otherwise.
 * Spread first so any member pi adds to `ProviderStreams` later still passes through.
 */
export function wrapApiWithFetch(baseApi: ProviderStreams): ProviderStreams {
  return {
    ...baseApi,
    stream(model, context, options) {
      return baseApi.stream(model, context, { ...options, fetch: createKeepaliveFilteringFetch(options?.fetch) });
    },
    streamSimple(model, context, options) {
      return baseApi.streamSimple(model, context, { ...options, fetch: createKeepaliveFilteringFetch(options?.fetch) });
    },
  };
}

/**
 * The provider config pi registers. Built separately from the extension entry point so it can be
 * asserted without a live pi — every field below is required by pi's model resolution, and omitting
 * any one of them throws inside resolveCliModel and breaks *every* registered provider, not just
 * this one.
 */
export function xaiVertexProviderConfig(project: string) {
  const baseUrl = buildBaseUrl(project);
  const model: Model<"openai-completions"> = {
    id: MODEL_ID,
    provider: PROVIDER_ID,
    name: "Grok 4.6 (Vertex)",
    api: "openai-completions",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 500000,
    maxTokens: 65536,
    cost: GROK_4_6_COST,
  };
  return {
    id: PROVIDER_ID,
    name: "xAI Grok (Vertex)",
    baseUrl,
    auth: {
      // Ambient-only auth: no `login`, because there is nothing interactive to do — the credential
      // is Application Default Credentials, discovered from the environment. pi's ApiKeyAuth
      // documents an absent `login` as exactly this ("Absent = ambient-only"), and calls `resolve`
      // per request, so google-auth-library's own caching and renewal stay in charge of expiry.
      //
      // This must NOT be `auth.oauth`: that shape means "an interactive login mints a credential pi
      // then persists to ~/.pi/agent/auth.json", so pi refuses to use the provider until such a
      // credential exists. It appears to work on a machine that once logged in, and fails on every
      // fresh one — including a sandbox — with "No API key found for xai-vertex".
      apiKey: {
        name: "Google Cloud ADC (xAI Vertex)",
        async check() {
          // Side-effect-free relative to resolve(), which performs request-time credential
          // discovery — so pi asks this first to decide whether the model is available. (Note this
          // can still touch the network: with no other ADC source configured, google-auth-library
          // probes the GCE metadata server.)
          return (await hasAdcCredentials()) ? { type: "api_key" as const, source: "Google ADC" } : undefined;
        },
        async resolve() {
          return authResultFrom(await mintAccessToken());
        },
      },
    },
    models: [model],
    api: wrapApiWithFetch(openAICompletionsApi()),
  };
}

// One GoogleAuth per process: it caches the resolved client and the underlying credential, so
// repeated getAccessToken() calls only hit the network once the token has actually aged out.
let auth: GoogleAuth | undefined;

function googleAuth(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth;
}

async function mintAccessToken(): Promise<string | null | undefined> {
  const client = await googleAuth().getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/**
 * Whether ADC can be discovered at all, without minting a token.
 *
 * pi's `AuthCheck` can only say available/unavailable — there is no field for a reason — so an
 * unavailable provider otherwise surfaces as a bare "model not found", with nothing pointing at the
 * credentials. Since that opacity is what made the v0.1.0 auth bug hard to spot in the first place,
 * the discovery failure is written to stderr before returning false. pi captures extension stderr
 * (fullsend tees it to pi-debug.log), and this only fires when ADC is genuinely broken.
 *
 * Warned once per process: pi calls check() for each model-availability query, and repeating an
 * identical multi-line credential error turns a useful hint into noise.
 */
let warnedAdcUnavailable = false;

async function hasAdcCredentials(): Promise<boolean> {
  try {
    await googleAuth().getClient();
    return true;
  } catch (error) {
    if (!warnedAdcUnavailable) {
      warnedAdcUnavailable = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[xai-vertex] Google ADC unavailable, so the provider will not be offered: ${reason}. ` +
          "Run `gcloud auth application-default login`, or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
      );
    }
    return false;
  }
}

/**
 * v0.1.0 declared `auth.oauth`, so anyone who ran `pi login` for this provider has a
 * `{ "type": "oauth" }` entry for it in auth.json. pi resolves auth by *stored credential type*
 * first: with a stored oauth credential and no `auth.oauth` on the provider, both
 * resolveProviderAuth() and checkProviderAuth() short-circuit to undefined and never reach the
 * ambient apiKey path below. The provider then vanishes from --list-models and requests fail with
 * "No API key found" — on a machine that used to work.
 *
 * pi gates before calling into the provider, so the extension cannot intercept and repair this at
 * resolve time. Detect it at load and say exactly what to delete, so the failure explains itself
 * instead of looking like the bug v0.1.1 fixed.
 */
export function staleOAuthCredentialPath(readFile: (p: string) => string = (f) => readFileSync(f, "utf8")): string | undefined {
  let authPath: string;
  try {
    authPath = join(getAgentDir(), "auth.json");
  } catch {
    return undefined;
  }
  try {
    const stored = JSON.parse(readFile(authPath)) as Record<string, { type?: string } | undefined>;
    return stored?.[PROVIDER_ID]?.type === "oauth" ? authPath : undefined;
  } catch {
    // No auth.json, unreadable, or not JSON — nothing to migrate.
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const project = resolveProject();
  if (!project) {
    // No project configured — don't register a provider that would fail at call time with a
    // confusing auth error. Silently skip, same posture as a disabled hook.
    return;
  }
  const stale = staleOAuthCredentialPath();
  if (stale) {
    console.error(
      `[${PROVIDER_ID}] Found a leftover OAuth credential from v0.1.0 in ${stale}. ` +
        `Auth is now ambient (Application Default Credentials), and pi will ignore this provider ` +
        `while that entry exists. Remove the "${PROVIDER_ID}" entry from that file — ` +
        `\`pi logout ${PROVIDER_ID}\` if your pi version supports it, otherwise edit it out.`,
    );
  }
  pi.registerProvider(createProvider(xaiVertexProviderConfig(project)));
}
