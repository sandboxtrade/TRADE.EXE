import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

globalThis.window = {
  setTimeout,
  clearTimeout,
};

let fetchCalls = [];
let replySequence = [];
let reply = {
  status: 200,
  body: {
    text: "Да, я поняла, о чём ты.\nПросто я бы тут не спешила с выводом.",
    messages: [
      "Да, я поняла, о чём ты.",
      "Просто я бы тут не спешила с выводом.",
    ],
    model: "gpt-6-luna",
    usage: {
      inputTokens: 720,
      cachedInputTokens: 10,
      cacheWriteTokens: 0,
      outputTokens: 28,
      estimatedCostUsd: 0.000086,
    },
    budget: {
      requestChars: 4200,
      originalRequestChars: 5100,
      estimatedInputTokens: 1800,
      estimatedMaxCostUsd: 0.00031,
      compacted: true,
      compactionSteps: ["recent-8"],
    },
    conversation: {
      topic: "вчерашний разговор",
      continuesPrevious: true,
      openThread: "",
    },
    signals: {
      userTone: "neutral",
      relationshipEvent: "none",
      memoryCandidate: "",
      memoryUsed: true,
      emotionTone: "warm",
    },
    shouldInitiate: true,
    emotionReaction: {
      happiness: 0.2, sadness: 0, irritation: -0.1, anxiety: 0,
      curiosity: 0.3, boredom: -0.1, affection: 0.1, romanticInterest: 0,
    },
    relationshipReaction: {
      trust: 0, closeness: 0.1, attachment: 0, security: 0, respect: 0, unresolvedTension: -0.1,
    },
  },
};

const successfulBody = structuredClone(reply.body);

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options });
  const selected = replySequence.length ? replySequence.shift() : reply;
  return new Response(JSON.stringify(selected.body), {
    status: selected.status,
    headers: { "Content-Type": "application/json" },
  });
};

let idTokenCalls = 0;
let appCheckTokenCalls = 0;
const idTokenForces = [];
const appCheckTokenForces = [];
globalThis.__authMock = {
  getAuth: () => ({
    currentUser: {
      getIdToken: async (forceRefresh) => {
        idTokenCalls += 1;
        idTokenForces.push(forceRefresh);
        return forceRefresh ? "firebase-id-token-refresh" : "firebase-id-token";
      },
    },
  }),
};

globalThis.__firebaseMock = {
  isFirebaseConfigured: true,
  getFirebaseApp: () => ({ name: "app" }),
  getFirebaseAppCheckToken: async (forceRefresh) => {
    appCheckTokenCalls += 1;
    appCheckTokenForces.push(forceRefresh);
    return forceRefresh ? "app-check-token-refresh" : "app-check-token";
  },
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "firebase/auth") return { url: "mock:auth", shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const candidate = new URL(specifier, context.parentURL);
      if (!candidate.pathname.match(/\.[a-z0-9]+$/iu) && existsSync(fileURLToPath(candidate) + ".ts"))
        return { url: candidate.href + ".ts", shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:auth")
      return { source: "export const {getAuth}=globalThis.__authMock;", format: "module", shortCircuit: true };
    if (url.endsWith("/storage/firebase.ts"))
      return {
        source: "export const {isFirebaseConfigured,getFirebaseApp,getFirebaseAppCheckToken}=globalThis.__firebaseMock;",
        format: "module",
        shortCircuit: true,
      };
    if (url.endsWith("/config/runtime-config.ts"))
      return {
        source: 'export const runtimeCloudLanguageEndpoint="https://shy-unit-ebfb.ermilov-stepa228337.workers.dev/yuzukiSpeak";',
        format: "module",
        shortCircuit: true,
      };
    if (url.endsWith(".ts"))
      return { source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }), format: "module", shortCircuit: true };
    return next(url, context);
  },
});

const { shouldUseCloudLanguage, renderCloudLanguage } = await import("../src/ai/cloud-language.ts");

const base = {
  mode: "reply",
  userText: "Я всё думаю о том разговоре вчера, как ты это видишь?",
  personality: "Yuzuki самостоятельная, любопытная, может спорить и любит сухой юмор.",
  memory: "Вчера мы долго обсуждали важную для него ситуацию. Я решила не торопить его с выводами.",
  world: {
    timeOfDay: "evening",
    location: "living_room",
    activity: "relaxing",
    availability: "free",
    isAwake: true,
    connectionDrive: 0.5,
    activityDetail: "просто лежу и даю голове немного затихнуть",
  },
  relationship: { stage: "close", trust: 0.7, closeness: 0.7, attachment: 0.6, security: 0.7, respect: 0.8, unresolvedTension: 0.1 },
  emotion: { mood: 0.6, energy: 0.55, happiness: 0.5, sadness: 0.1, irritation: 0.1, anxiety: 0.1, curiosity: 0.6, boredom: 0.1, affection: 0.7, romanticInterest: 0.4 },
  romancePhase: "neutral",
  appearanceRequest: {
    requestedVibe: "different",
    outcome: "accepted",
    reason: "variant-change",
    selectedEmotion: "comfortable",
    suggestive: false,
  },
  intimacy: {
    enabled: false,
    phase: "normal",
    interactionStatus: "inactive",
    comfort: 0,
    interest: 0,
    arousal: 0,
    initiativeDrive: 0,
    signal: { kind: "none", strength: 0, explicit: false, intimacyContext: false },
    mind: {
      active: false,
      tenderness: 0,
      desire: 0,
      caution: 0,
      playfulness: 0,
      confidence: 0,
      conflicted: false,
      preferredPace: "slow",
      inwardArousal: false,
      outwardArousal: false,
      wantsCloseness: false,
      wantsMore: false,
      activePreferenceKeys: [],
      reflection: "Intimacy is not currently active in her attention.",
    },
  },
  recentHistory: [
    { role: "user", text: "Вчера мы об этом уже говорили." },
    { role: "character", text: "Я бы не делала из этого быстрый вывод." },
  ],
  silent: false,
};

assert.equal(shouldUseCloudLanguage(base), true);
// v0.19: GPT is the default conversation path for every non-silent user turn.
assert.equal(shouldUseCloudLanguage({ ...base, userText: "Привет" }), true);
assert.equal(shouldUseCloudLanguage({ ...base, userText: "Точно?" }), true);
assert.equal(shouldUseCloudLanguage({ ...base, constraint: { locked: true, kind: "boundary", summary: "Не продолжать." } }), true);
assert.equal(shouldUseCloudLanguage({
  ...base,
  intimacy: {
    ...base.intimacy,
    enabled: true,
    phase: "high_intimacy",
    interactionStatus: "open",
    comfort: 1,
    interest: 1,
    arousal: 1,
    initiativeDrive: 0.8,
    signal: { kind: "flirt", strength: 0.9, explicit: false, intimacyContext: true },
    mind: {
      ...base.intimacy.mind,
      active: true,
      desire: 0.9,
      playfulness: 0.8,
      confidence: 0.8,
      inwardArousal: true,
      outwardArousal: true,
      wantsCloseness: true,
      wantsMore: true,
      preferredPace: "responsive",
      reflection: "The attraction is strong enough to show in her wording.",
    },
  },
}), true);
assert.equal(shouldUseCloudLanguage({ ...base, silent: true }), false);
assert.equal(shouldUseCloudLanguage({ ...base, mode: "initiative", userText: "", proactive: { kind: "autonomous_check" } }), true);

const result = await renderCloudLanguage(base);
assert.equal(result.used, true);
assert.equal(result.model, "gpt-6-luna");
assert.equal(result.usage?.cacheWriteTokens, 0);
assert.equal(result.budget?.compacted, true);
assert.equal(result.budget?.requestChars, 4200);
assert.deepEqual(result.budget?.compactionSteps, ["recent-8"]);
assert.equal(result.conversation?.continuesPrevious, true);
assert.equal(result.conversation?.topic, "вчерашний разговор");
assert.equal(result.signals?.userTone, "neutral");
assert.equal(result.signals?.memoryUsed, true);
assert.equal(result.signals?.emotionTone, "warm");
assert.equal(result.shouldInitiate, true);
assert.equal(result.emotionReaction?.curiosity, 0.3);
assert.equal(result.relationshipReaction?.closeness, 0.1);
assert.deepEqual(result.messages, [
  "Да, я поняла, о чём ты.",
  "Просто я бы тут не спешила с выводом.",
]);
assert.equal(idTokenCalls, 1);
assert.equal(appCheckTokenCalls, 1);
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, "https://shy-unit-ebfb.ermilov-stepa228337.workers.dev/yuzukiSpeak");
assert.equal(fetchCalls[0].options.method, "POST");
assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer firebase-id-token");
assert.equal(fetchCalls[0].options.headers["X-Firebase-AppCheck"], "app-check-token");
assert.equal(fetchCalls[0].options.credentials, "omit");
assert.equal(fetchCalls[0].options.cache, "no-store");
const sent = JSON.parse(fetchCalls[0].options.body);
assert.equal(sent.userText, base.userText);
assert.equal(sent.personality, base.personality);
assert.equal(sent.memory, base.memory);
assert.equal(sent.world.activity, "relaxing");
assert.equal(sent.emotion.energy, 0.55);
assert.equal(sent.intimacy.signal.kind, "none");
assert.equal(sent.intimacy.mind.inwardArousal, false);
assert.deepEqual(sent.appearanceRequest, base.appearanceRequest);
for (const legacy of ["localDraft", "facts", "memories", "openThreads", "recoveredHistory", "retrospective", "causal", "continuity", "semantic", "thought"])
  assert.equal(legacy in sent, false);

reply = {
  status: 200,
  body: {
    messages: [],
    shouldInitiate: false,
    model: "gpt-6-luna",
    conversation: { topic: "", continuesPrevious: false, openThread: "" },
    signals: { userTone: "neutral", relationshipEvent: "none", memoryUsed: false, emotionTone: "neutral" },
    emotionReaction: { happiness: 0, sadness: 0, irritation: 0, anxiety: 0, curiosity: 0, boredom: 0, affection: 0, romanticInterest: 0 },
    relationshipReaction: { trust: 0, closeness: 0, attachment: 0, security: 0, respect: 0, unresolvedTension: 0 },
  },
};
const declinedInitiative = await renderCloudLanguage({
  ...base, mode: "initiative", userText: "", proactive: { kind: "autonomous_check", quietMinutes: 90 },
});
assert.equal(declinedInitiative.used, true);
assert.equal(declinedInitiative.shouldInitiate, false);
assert.deepEqual(declinedInitiative.messages, []);
assert.equal(declinedInitiative.text, undefined);

reply = {
  status: 200,
  body: { skipped: true, reason: "server-budget", model: "gpt-6-luna", budget: { estimatedMaxCostUsd: 0.0005 } },
};
const skipped = await renderCloudLanguage({ ...base, userText: base.userText + " ещё" });
assert.equal(skipped.attempted, true);
assert.equal(skipped.used, false);
assert.equal(skipped.reason, "server-budget");
assert.equal(skipped.budget?.estimatedMaxCostUsd, 0.0005);

const callsBeforeLocal = fetchCalls.length;
const localOnly = await renderCloudLanguage({ ...base, silent: true });
assert.equal(localOnly.attempted, false);
assert.equal(localOnly.reason, "local-route");
assert.equal(fetchCalls.length, callsBeforeLocal);

replySequence = [
  { status: 401, body: { error: "invalid-auth" } },
  { status: 200, body: successfulBody },
];
const refreshResult = await renderCloudLanguage({ ...base, userText: base.userText + " снова" });
assert.equal(refreshResult.used, true);
assert.deepEqual(idTokenForces.slice(-2), [false, true]);
assert.deepEqual(appCheckTokenForces.slice(-2), [false, true]);
assert.equal(fetchCalls.at(-1).options.headers.Authorization, "Bearer firebase-id-token-refresh");
assert.equal(fetchCalls.at(-1).options.headers["X-Firebase-AppCheck"], "app-check-token-refresh");

const callsBeforeTransientRetry = fetchCalls.length;
replySequence = [
  { status: 200, body: { skipped: true, reason: "openai-timeout", model: "gpt-6-luna" } },
  { status: 200, body: successfulBody },
];
const recoveredTransient = await renderCloudLanguage({ ...base, userText: base.userText + " после сбоя" });
assert.equal(recoveredTransient.used, true);
assert.equal(fetchCalls.length - callsBeforeTransientRetry, 2);

const cloudSource = readFileSync(new URL("../src/ai/cloud-language.ts", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../cloudflare/worker.js", import.meta.url), "utf8");
assert.match(cloudSource, /mode\?: "reply" \| "initiative"/);
assert.match(cloudSource, /input\.mode === "initiative"/);
assert.match(workerSource, /mode === "initiative"/);
assert.match(workerSource, /\.slice\(-30\)/);
assert.match(workerSource, /MEMORY — единственная каноническая долговременная память/);
assert.match(workerSource, /personality: clippedMultiline\(raw\.personality, 9000\)/);
assert.match(workerSource, /memory: clippedMultiline\(raw\.memory, 18000\)/);
assert.match(cloudSource, /isRetryableCloudFailure/);
assert.match(workerSource, /Не перезапускай беседу generic-фразами/);

console.log("PASS cloud dialogue: manual personality/memory, GPT-first routing, multi-bubble replies, 30-message context, Cloudflare transport, token refresh, Auth, App Check and local fallback");
