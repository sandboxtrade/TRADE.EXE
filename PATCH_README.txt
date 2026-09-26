Yuzuki v0.19.4 patch
Base: virtual-companion-current-full-v0.19.3-no-photos.zip
SCHEMA_VERSION remains 4.

What changed:
- Yuzuki's routine is home-bound: no walk/cafe/errands scheduling. Existing world enum values remain for persistence compatibility.
- Settings hide the character photo and use the full remaining screen.
- Personality and Memory open in dedicated full-screen mobile editors with 16px text and paste/save controls.
- Conversation export opens in a dedicated full-screen viewer.
- Mid-conversation generic starter chips are hidden; they only appear before the first message.
- Cloud dialogue performs one rescue retry for transient Worker/OpenAI failures before showing the technical local fallback.
- Worker OpenAI timeout raised from 10s to 13s.
- Dialogue prompt hardened against generic assistant-like questions, paraphrase-first replies, habitual emojis and overly polished wording.
- ENGINE_VERSION/package version -> 0.19.4. SCHEMA_VERSION stays 4.

Important:
1) Replace/add only the files present in this patch. Do NOT replace src/assets/character/scenes/ and do not delete any photos.
2) cloudflare/worker.js does not deploy automatically with GitHub Pages. After updating GitHub, copy this worker.js into Worker shy-unit-ebfb and press Deploy.
3) OPENAI_API_KEY remains only a Cloudflare Production Secret. Do not put it in GitHub/runtime-config/frontend.
4) Local verification: npm test PASS (210 regression checks, 120 canonical NLU scenarios, 400-turn stress, AI transport, cloud dialogue). Changed TS/TSX files parse/transpile PASS; Worker syntax PASS.
5) GitHub Actions should still be checked for test -> typecheck -> build because the audit container does not contain the project's node_modules.
