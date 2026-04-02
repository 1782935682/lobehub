# Change List

## Maintenance Rules

- This file uses append-only records. Do not overwrite historical entries.
- After every code change, update this file in the same iteration.
- Each entry must include: date, purpose, modified files, concrete changes.
- If new switches are added, record: name, default, behavior, impact scope.
- If existing switches are changed, record before/after differences.
- If functional impact is possible, record risk and rollback steps.

---

## 2026-03-30 - Reduce Repeated LLM Payload Context In Agent Runtime

### Purpose

Reduce model request token usage by prioritizing repeated-context elimination before `modelRuntime.chat` while keeping runtime behavior basically usable.

### Modified Files

- `src/server/modules/AgentRuntime/RuntimeExecutors.ts`
- `src/server/modules/AgentRuntime/payloadOptimization.ts`
- `src/server/modules/AgentRuntime/__tests__/payloadOptimization.test.ts`

### Concrete Changes

- Added payload optimization call before sending chat payload to model runtime.
- Added conditional system prompt injection:
  - Inject `agentConfig.systemRole` only when it is non-empty and request messages do not already contain a `system` role.
- Added conditional tool config injection:
  - Inject `toolsConfig` only when function call is supported and enabled tool IDs exist.
  - `toolsConfig.manifests` narrowed to enabled tool IDs only.
- Implemented payload optimization pipeline:
  - History trimming (`maxHistoryMessages`) while avoiding dangling leading `tool/function` message.
  - Assistant history truncation for long responses (`maxAssistantMessageChars`).
  - System prompt merging, duplicate removal, and max-length trimming (`maxSystemPromptChars`).
  - Wrapper/context block cleanup and duplicate block elimination:
    - `<files_info>`, `<images>`, `<available_skills>`, `<topic_reference_context>`.
  - Historical base64 payload stripping for non-latest user message text blocks.
  - Old image/video context removal (keep only recent N image messages).
  - Tool deduplication and on-demand tool selection with upper bound (`maxTools`).
- Added richer payload size logs (before/after):
  - total chars, estimated tokens, system/assistant/user/tool/function chars,
  - wrapper chars, base64 chars, image count/url chars, tools count/chars,
  - impact counters for each optimization stage.
- Added unit tests for:
  - history + assistant truncation,
  - old image pruning,
  - duplicate system merge + trim,
  - duplicate context block/base64 cleanup,
  - tool dedup + function-call-disabled behavior.

### New Switches

- `LLM_PAYLOAD_MAX_TOOLS`
  - Default: `24`
  - Behavior: maximum number of tools kept in optimized payload (after dedupe/on-demand selection).
  - Impact scope: `AgentRuntime` LLM request payload tool declarations.
- `LLM_PAYLOAD_OPTIMIZE_ENABLED`
  - Default: enabled (`!= '0'`)
  - Behavior: global toggle for payload optimization pipeline.
  - Impact scope: full `call_llm` payload build.
- `LLM_PAYLOAD_MAX_ASSISTANT_CHARS`
  - Default: `6000`
  - Behavior: truncates long assistant history message content.
  - Impact scope: historical assistant context in payload messages.
- `LLM_PAYLOAD_MAX_HISTORY_MESSAGES`
  - Default: `24`
  - Behavior: limits non-system history message count.
  - Impact scope: payload message length and context window usage.
- `LLM_PAYLOAD_MAX_SYSTEM_CHARS`
  - Default: `12000`
  - Behavior: trims merged system prompt content.
  - Impact scope: system prompt token size.
- `LLM_PAYLOAD_ON_DEMAND_TOOLS`
  - Default: enabled (`!= '0'`)
  - Behavior: enables on-demand tool selection; when function call is disabled, tools are removed.
  - Impact scope: tool/function declaration tokens and tool availability.
- `LLM_PAYLOAD_SKIP_OLD_IMAGES`
  - Default: enabled (`!= '0'`)
  - Behavior: drops visual parts from older image user messages.
  - Impact scope: multimodal context payload size.
- `LLM_PAYLOAD_SLIM_SYSTEM_PROMPT`
  - Default: enabled (`!= '0'`)
  - Behavior: merges and trims system messages.
  - Impact scope: system-level instruction token size.
- `LLM_PAYLOAD_STRIP_WRAPPER_NOISE`
  - Default: enabled (`!= '0'`)
  - Behavior: removes empty/repeated wrapper blocks and extra repeated context injection text.
  - Impact scope: text payload redundancy.
- `LLM_PAYLOAD_TRAILING_IMAGE_MESSAGES`
  - Default: `2`
  - Behavior: number of latest image messages to keep with visual parts.
  - Impact scope: image/video context retention.

### Existing Switch Changes

- None in this iteration (no default value or semantic change to previously existing switches was applied).

### Risks

- Tool on-demand selection may omit rarely-used but needed tools in some prompts.
- Trimming history/system/assistant content can reduce long-context fidelity.
- Removing older image payload can reduce model’s direct access to early-round visual details.

### Rollback

- Fast rollback (runtime):
  - Set `LLM_PAYLOAD_OPTIMIZE_ENABLED=0` to disable optimization pipeline.
- Partial rollback:
  - Disable specific switches (`LLM_PAYLOAD_ON_DEMAND_TOOLS=0`, `LLM_PAYLOAD_SKIP_OLD_IMAGES=0`, etc.).
- Code rollback:
  - Revert commits touching:
    - `src/server/modules/AgentRuntime/RuntimeExecutors.ts`
    - `src/server/modules/AgentRuntime/payloadOptimization.ts`
    - `src/server/modules/AgentRuntime/__tests__/payloadOptimization.test.ts`

---

## 2026-03-30 - Add SIMPLE_CHAT_ONLY Lightweight Chat Switch

### Purpose

Introduce a single global switch to force pure-chat lightweight payload mode and disable non-essential agent capabilities (tools/skills/web-browsing instruction injection) for lower token cost.

### Modified Files

- `src/server/modules/AgentRuntime/RuntimeExecutors.ts`
- `src/server/modules/AgentRuntime/payloadOptimization.ts`
- `src/server/modules/AgentRuntime/__tests__/payloadOptimization.test.ts`

### Concrete Changes

- Added total switch read at runtime:
  - `SIMPLE_CHAT_ONLY === 'true'` enables lightweight chat mode.
- In lightweight mode, `call_llm` bypasses context-engine injection path:
  - skips server-side tool/skills/web-browsing related system context injection,
  - uses direct chat messages as payload source before optimization.
- In lightweight mode, payload construction disables tools/function declarations:
  - `tools` passed to optimizer as `undefined`,
  - optimizer forcibly drops all tools even if input accidentally contains them.
- Added lightweight payload strategy in optimizer:
  - force short history and assistant truncation defaults,
  - force a minimal short system prompt,
  - remove wrapper blocks (`SYSTEM CONTEXT`, `files_info`, `images`, `available_skills`, `topic_reference_context`),
  - keep only recent image messages (conservative multimodal context).
- Added explicit runtime logs for validation:
  - whether lightweight mode is on,
  - whether system/tools/function declarations are injected,
  - final history count and image count.
- Added tests for lightweight mode:
  - verifies minimal system prompt + no tools,
  - verifies wrapper block stripping in lightweight mode.

### New Switches

- `SIMPLE_CHAT_ONLY`
  - Default: `false` (disabled when env not set)
  - Behavior:
    - when `true`, force pure-chat lightweight payload mode;
    - disable tools/function declarations payload;
    - bypass context-engine system/tool/skills injection in `call_llm`;
    - apply strict message slimming defaults.
  - Impact scope:
    - `src/server/modules/AgentRuntime/RuntimeExecutors.ts`
    - `src/server/modules/AgentRuntime/payloadOptimization.ts`

### Existing Switch Changes

- No semantic change for existing switches when `SIMPLE_CHAT_ONLY=false`.
- When `SIMPLE_CHAT_ONLY=true`, existing `LLM_PAYLOAD_*` switches are effectively overridden by lightweight defaults for key dimensions (history/system/tools/images), unless explicitly overridden in code-level config overrides.

### Risks

- In lightweight mode, tool-dependent tasks (web browsing/tool calling/skills-driven behavior) are intentionally unavailable.
- Bypassing context-engine injection may reduce behavior consistency for agents relying on advanced system context.
- Stronger truncation/history limits may reduce long-conversation recall.

### Rollback

- Set `SIMPLE_CHAT_ONLY=false` or remove env var to restore previous behavior.
- If needed, revert modified files:
  - `src/server/modules/AgentRuntime/RuntimeExecutors.ts`
  - `src/server/modules/AgentRuntime/payloadOptimization.ts`
  - `src/server/modules/AgentRuntime/__tests__/payloadOptimization.test.ts`

---

## 2026-03-30 - Wire SIMPLE_CHAT_ONLY Into Main Chat Route

### Purpose

Make `SIMPLE_CHAT_ONLY` effective for the normal chat main path (`webapi/chat/[provider]`) instead of only AgentRuntime path.

### Modified Files

- `src/app/(backend)/webapi/chat/[provider]/route.ts`
- `src/app/(backend)/webapi/chat/[provider]/route.test.ts`

### Concrete Changes

- Added lightweight mode branch in main chat route:
  - reads `SIMPLE_CHAT_ONLY === 'true'`;
  - when enabled and `messages` is an array, runs `optimizeChatPayloadForToken(..., { lightweightChatOnly: true })`;
  - forces `tools: undefined` before `modelRuntime.chat`.
- Added debug log for main chat route lightweight mode:
  - mode flag,
  - whether system message exists,
  - tools count,
  - history count,
  - image count,
  - token estimate before/after optimization.
- Added route unit test to verify:
  - tools removed,
  - minimal system prompt inserted,
  - wrapper block (`<files_info>`) removed from user content.

### New Switches

- None (reused existing `SIMPLE_CHAT_ONLY`).

### Existing Switch Changes

- `SIMPLE_CHAT_ONLY`
  - Before: effective mainly on AgentRuntime request path.
  - After: effective on both AgentRuntime and main chat route (`webapi/chat/[provider]`).

### Risks

- Main chat route in lightweight mode may produce shorter-context answers due to aggressive slimming.
- Any flow expecting tools in this route will no longer receive them when switch is enabled.

### Rollback

- Runtime rollback: set `SIMPLE_CHAT_ONLY=false`.
- Code rollback: revert
  - `src/app/(backend)/webapi/chat/[provider]/route.ts`
  - `src/app/(backend)/webapi/chat/[provider]/route.test.ts`

---

## 2026-03-31 - MCP Market Fallback and Today Spend Date Matching Fix

### Purpose

Fix two user-visible issues:

- MCP market list request failure caused blank/skeleton-only list.
- "Today Spend" card showed `0` due to date matching mismatch.

### Modified Files

- `src/server/services/discover/index.ts`
- `src/server/services/discover/index.test.ts`
- `src/routes/(main)/settings/stats/features/usage/UsageCards/TodaySpend.tsx`

### Concrete Changes

- MCP market list fallback:
  - wrapped `getMcpList` market SDK call in `try/catch`;
  - when upstream throws, return a valid empty paginated response instead of propagating server error.
- Added test for MCP fallback path:
  - verifies empty response structure (`items: []`, `categories: []`, pagination fields kept) when SDK throws.
- Today spend date matching:
  - replaced `dayjs.utc(log.day).isToday()/isYesterday()` with direct `YYYY-MM-DD` key comparison using local day keys;
  - avoids timezone-shift mismatch where current-day records are not matched.

### Risks

- MCP failure now degrades to empty data; root-cause logs are still required to diagnose upstream availability/auth issues.
- Date comparison now follows local calendar day semantics (expected for UI cards), not UTC day boundaries.

### Rollback

- Revert files:
  - `src/server/services/discover/index.ts`
  - `src/server/services/discover/index.test.ts`
  - `src/routes/(main)/settings/stats/features/usage/UsageCards/TodaySpend.tsx`

---

## 2026-04-02 - Tool Injection Scope Tightening and Bot/Usage Stability Sync

### Purpose

Sync latest `canary` changes into local branch, and ensure merged bot/runtime behavior stays stable after conflict resolution.

### Modified Files

- `src/helpers/toolEngineering/index.ts`
- `src/server/modules/Mecha/AgentToolsEngine/index.ts`
- `src/server/services/aiAgent/index.ts`
- `src/store/chat/slices/aiChat/actions/streamingExecutor.ts`
- `src/server/services/bot/BotMessageRouter.ts`
- `src/server/services/bot/AgentBridgeService.ts`
- `src/server/services/bot/__tests__/AgentBridgeService.test.ts`
- `src/server/services/bot/__tests__/BotMessageRouter.test.ts`
- `src/server/services/bot/platforms/wechat/client.ts`
- `packages/chat-adapter-wechat/src/adapter.ts`
- `packages/chat-adapter-wechat/src/api.ts`
- `packages/chat-adapter-wechat/src/types.ts`
- `src/routes/(main)/agent/channel/platform/wechat/ConnectedInfo.tsx`
- `src/routes/(main)/agent/channel/platform/wechat/CredentialBody.tsx`
- `src/routes/(main)/agent/channel/platform/wechat/QrCodeAuth.tsx`
- `src/server/services/usage/index.ts`
- `src/server/services/usage/index.test.ts`

### Concrete Changes

- Tool manifest injection scope tightened:
  - runtime prompt injection now builds `toolManifestMap` from `toolsResult.enabledManifests` only;
  - avoids disabled/default-only tools leaking into operation prompt context.
- Agent topic validity guard:
  - when incoming `topicId` does not belong to current agent/user context, fallback to new topic creation.
- WeChat bot robustness updates:
  - enable DM routing by default;
  - normalize bot token auth handling and persist `baseUrl` across adapter/client path;
  - harden stale `topic_id` FK recovery path and reduce duplicate reply/progress behavior on non-editable platforms.
- Usage daily padding fix:
  - include month-end boundary day in daily usage fill logic to avoid last-day data gaps.
- Post-merge local regression fix (during this rebase verification):
  - in in-memory bot completion callback, when `finalState.error` exists but no assistant content, now edits/posts explicit error message before reject.

### New Switches

- None.

### Existing Switch Changes

- None.

### Risks

- Enabled-manifest-only injection may reduce tool visibility for flows that implicitly depended on non-enabled manifests.
- WeChat message-edit capability branching now differs by platform metadata; if platform capability config is wrong, progress display style may differ from expectation.
- Topic validity fallback creates a new topic when mismatch detected, which changes previous "force reuse topicId" behavior.

### Rollback

- Revert corresponding commits/files above to restore previous behavior.
- For fast isolation, rollback in this order:
  - bot behavior files (`AgentBridgeService.ts`, `BotMessageRouter.ts`, WeChat adapter/client files);
  - tool injection files (`aiAgent/index.ts`, `AgentToolsEngine/index.ts`, `toolEngineering/index.ts`);
  - usage padding files (`usage/index.ts`, `usage/index.test.ts`).
