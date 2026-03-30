import type {
  ChatCompletionTool,
  OpenAIChatMessage,
  UserMessageContentPart,
} from '@lobechat/model-runtime';
import debug from 'debug';

const log = debug('lobe-server:agent-runtime:payload-optimizer');

interface PayloadMetrics {
  assistantChars: number;
  base64Chars: number;
  estimatedTokens: number;
  functionChars: number;
  historyCount: number;
  imageCount: number;
  imageUrlChars: number;
  systemChars: number;
  systemPromptLength: number;
  toolMessageChars: number;
  toolsChars: number;
  toolsCount: number;
  totalChars: number;
  userChars: number;
  wrapperChars: number;
}

interface PayloadOptimizationConfig {
  enable: boolean;
  maxAssistantMessageChars: number;
  maxHistoryMessages: number;
  maxSystemPromptChars: number;
  maxTools: number;
  onDemandTools: boolean;
  skipDuplicateOldImages: boolean;
  slimSystemPrompt: boolean;
  stripWrapperNoise: boolean;
  trailingImageMessageCount: number;
}

interface PayloadOptimizationInput {
  messages: OpenAIChatMessage[];
  tools?: ChatCompletionTool[];
}

interface PayloadOptimizationOptions {
  canUseFunctionCall?: boolean;
  model?: string;
  provider?: string;
}

interface PayloadOptimizationResult {
  after: PayloadMetrics;
  before: PayloadMetrics;
  impact: PayloadOptimizationImpact;
  messages: OpenAIChatMessage[];
  tools?: ChatCompletionTool[];
}

interface PayloadOptimizationImpact {
  assistantTrimmedChars: number;
  assistantTruncatedCount: number;
  base64SegmentsStripped: number;
  duplicateContextBlocksDropped: number;
  historyDroppedCount: number;
  historyDroppedToolMessages: number;
  imageMessagesPrunedCount: number;
  imagePartsDroppedCount: number;
  systemDroppedDuplicateCount: number;
  systemMergedCount: number;
  systemTrimmedChars: number;
  toolsDroppedCount: number;
  toolsNameDedupedCount: number;
}

const DEFAULT_CONFIG: PayloadOptimizationConfig = {
  enable: process.env.LLM_PAYLOAD_OPTIMIZE_ENABLED !== '0',
  maxTools: Number(process.env.LLM_PAYLOAD_MAX_TOOLS || 24),
  maxAssistantMessageChars: Number(process.env.LLM_PAYLOAD_MAX_ASSISTANT_CHARS || 6000),
  maxHistoryMessages: Number(process.env.LLM_PAYLOAD_MAX_HISTORY_MESSAGES || 24),
  maxSystemPromptChars: Number(process.env.LLM_PAYLOAD_MAX_SYSTEM_CHARS || 12000),
  onDemandTools: process.env.LLM_PAYLOAD_ON_DEMAND_TOOLS !== '0',
  skipDuplicateOldImages: process.env.LLM_PAYLOAD_SKIP_OLD_IMAGES !== '0',
  slimSystemPrompt: process.env.LLM_PAYLOAD_SLIM_SYSTEM_PROMPT !== '0',
  stripWrapperNoise: process.env.LLM_PAYLOAD_STRIP_WRAPPER_NOISE !== '0',
  trailingImageMessageCount: Number(process.env.LLM_PAYLOAD_TRAILING_IMAGE_MESSAGES || 2),
};

const WRAPPER_TAG_PATTERNS = [
  /<!--\s*SYSTEM CONTEXT\s*-->/gi,
  /<files_info>/gi,
  /<\/files_info>/gi,
  /<images>/gi,
  /<\/images>/gi,
  /<image\s[^>]*>/gi,
  /<available_skills>/gi,
  /<\/available_skills>/gi,
  /<topic_reference_context>/gi,
  /<\/topic_reference_context>/gi,
];

const CONTEXT_BLOCK_TAGS = ['available_skills', 'files_info', 'images', 'topic_reference_context'];
const BASE64_DATA_URI_REGEX = /data:(?:image|video)\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]{120,}/g;

const estimateTokens = (textLength: number) => Math.ceil(textLength / 4);

const clampPositiveInt = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
};

const normalizeConfig = (
  overrides?: Partial<PayloadOptimizationConfig>,
): PayloadOptimizationConfig => {
  const merged = { ...DEFAULT_CONFIG, ...overrides };

  return {
    ...merged,
    maxTools: clampPositiveInt(merged.maxTools, DEFAULT_CONFIG.maxTools),
    maxAssistantMessageChars: clampPositiveInt(
      merged.maxAssistantMessageChars,
      DEFAULT_CONFIG.maxAssistantMessageChars,
    ),
    maxHistoryMessages: clampPositiveInt(
      merged.maxHistoryMessages,
      DEFAULT_CONFIG.maxHistoryMessages,
    ),
    maxSystemPromptChars: clampPositiveInt(
      merged.maxSystemPromptChars,
      DEFAULT_CONFIG.maxSystemPromptChars,
    ),
    trailingImageMessageCount: clampPositiveInt(
      merged.trailingImageMessageCount,
      DEFAULT_CONFIG.trailingImageMessageCount,
    ),
  };
};

const summarizeMetrics = (
  messages: OpenAIChatMessage[],
  tools?: ChatCompletionTool[],
): PayloadMetrics => {
  let imageCount = 0;
  let imageUrlChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolMessageChars = 0;
  let functionChars = 0;
  let systemChars = 0;
  let wrapperChars = 0;
  let base64Chars = 0;
  let systemPromptLength = 0;
  let totalChars = 0;

  messages.forEach((message) => {
    const content = message.content;

    if (typeof content === 'string') {
      totalChars += content.length;
      if (message.role === 'system') {
        systemPromptLength += content.length;
        systemChars += content.length;
      } else if (message.role === 'assistant') {
        assistantChars += content.length;
      } else if (message.role === 'user') {
        userChars += content.length;
      } else if (message.role === 'tool') {
        toolMessageChars += content.length;
      } else if (message.role === 'function') {
        functionChars += content.length;
      }

      wrapperChars += CONTEXT_BLOCK_TAGS.reduce((sum, tag) => {
        const regex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi');
        const matches = content.match(regex);
        if (!matches) return sum;
        return sum + matches.reduce((acc, block) => acc + block.length, 0);
      }, 0);

      const base64Matches = content.match(BASE64_DATA_URI_REGEX);
      if (base64Matches) {
        base64Chars += base64Matches.reduce((sum, segment) => sum + segment.length, 0);
      }

      return;
    }

    content.forEach((part) => {
      if (part.type === 'text') {
        totalChars += part.text.length;
        if (message.role === 'assistant') assistantChars += part.text.length;
        if (message.role === 'user') userChars += part.text.length;
        if (message.role === 'system') {
          systemChars += part.text.length;
          systemPromptLength += part.text.length;
        }
        if (message.role === 'tool') toolMessageChars += part.text.length;
        if (message.role === 'function') functionChars += part.text.length;
        return;
      }

      if (part.type === 'image_url' || part.type === 'video_url') {
        const rawUrl = part.type === 'image_url' ? part.image_url.url : part.video_url.url;
        imageCount += 1;
        imageUrlChars += rawUrl.length;
        totalChars += rawUrl.length;

        if (/^data:(?:image|video)\/[\w.+-]+;base64,/i.test(rawUrl)) {
          base64Chars += rawUrl.length;
        }
      }
    });
  });

  const toolsChars = tools?.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) ?? 0;
  totalChars += toolsChars;

  return {
    assistantChars,
    base64Chars,
    estimatedTokens: estimateTokens(totalChars),
    functionChars,
    historyCount: messages.length,
    imageCount,
    imageUrlChars,
    systemChars,
    systemPromptLength,
    toolMessageChars,
    toolsChars,
    toolsCount: tools?.length ?? 0,
    totalChars,
    userChars,
    wrapperChars,
  };
};

const trimTextMiddle = (text: string, maxChars: number, marker = '\n...[truncated]...\n') => {
  if (text.length <= maxChars) return text;

  const headLength = Math.max(32, Math.floor(maxChars * 0.8));
  const tailLength = Math.max(16, maxChars - headLength - marker.length);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
};

const stripWrapperNoise = (text: string) => {
  let output = text;

  output = output.replaceAll(/<files_info>\s*<\/files_info>/gi, '');
  output = output.replaceAll(/<images>\s*<\/images>/gi, '');
  output = output.replaceAll(/<available_skills>\s*<\/available_skills>/gi, '');
  output = output.replaceAll(/<topic_reference_context>\s*<\/topic_reference_context>/gi, '');
  output = output.replaceAll(/(<!--\s*SYSTEM CONTEXT\s*-->\s*){2,}/gi, '<!-- SYSTEM CONTEXT -->\n');
  output = output.replaceAll(/(<files_info>\s*){2,}/gi, '<files_info>\n');
  output = output.replaceAll(/(<\/files_info>\s*){2,}/gi, '</files_info>\n');
  output = output.replaceAll(/(<images>\s*){2,}/gi, '<images>\n');
  output = output.replaceAll(/(<\/images>\s*){2,}/gi, '</images>\n');
  output = output.replaceAll(/(<available_skills>\s*){2,}/gi, '<available_skills>\n');
  output = output.replaceAll(/(<\/available_skills>\s*){2,}/gi, '</available_skills>\n');
  output = output.replaceAll(/(<topic_reference_context>\s*){2,}/gi, '<topic_reference_context>\n');
  output = output.replaceAll(
    /(<\/topic_reference_context>\s*){2,}/gi,
    '</topic_reference_context>\n',
  );

  output = output.replaceAll(/\n{3,}/g, '\n\n');
  return output.trim();
};

const hasVisualPart = (content: OpenAIChatMessage['content']) =>
  Array.isArray(content) &&
  content.some((part) => part.type === 'image_url' || part.type === 'video_url');

const removeVisualParts = (content: OpenAIChatMessage['content']) => {
  if (!Array.isArray(content)) return content;

  const textParts = content.filter(
    (part): part is Extract<UserMessageContentPart, { type: 'text' }> => part.type === 'text',
  );

  if (textParts.length === 0) return '[historical image omitted]';
  return textParts;
};

const dedupeTools = (tools?: ChatCompletionTool[]) => {
  if (!tools || tools.length === 0) return { tools: undefined, toolsNameDedupedCount: 0 };

  const seen = new Set<string>();
  const result: ChatCompletionTool[] = [];
  let toolsNameDedupedCount = 0;

  for (const tool of tools) {
    const name = tool.function?.name;
    if (!name || seen.has(name)) {
      toolsNameDedupedCount += 1;
      continue;
    }

    seen.add(name);
    result.push(tool);
  }

  return { tools: result.length > 0 ? result : undefined, toolsNameDedupedCount };
};

const trimHistory = (messages: OpenAIChatMessage[], maxHistoryMessages: number) => {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  if (nonSystemMessages.length <= maxHistoryMessages) {
    return { historyDroppedCount: 0, historyDroppedToolMessages: 0, messages };
  }

  const trimmed = nonSystemMessages.slice(-maxHistoryMessages);
  const dropped = nonSystemMessages.slice(0, nonSystemMessages.length - maxHistoryMessages);

  // Avoid starting context with a dangling tool/function message.
  while (trimmed.length > 1 && (trimmed[0].role === 'tool' || trimmed[0].role === 'function')) {
    trimmed.shift();
  }

  const historyDroppedToolMessages = dropped.filter(
    (m) => m.role === 'tool' || m.role === 'function',
  ).length;

  return {
    historyDroppedCount: dropped.length,
    historyDroppedToolMessages,
    messages: [...systemMessages, ...trimmed],
  };
};

const dedupeOlderVisualMessages = (
  messages: OpenAIChatMessage[],
  trailingImageMessageCount: number,
): {
  imageMessagesPrunedCount: number;
  imagePartsDroppedCount: number;
  messages: OpenAIChatMessage[];
} => {
  const imageMessageIndexes = messages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => message.role === 'user' && hasVisualPart(message.content))
    .map(({ index }) => index);

  const keepImageIndexes = new Set(
    imageMessageIndexes.slice(-Math.max(1, trailingImageMessageCount)),
  );
  let imagePartsDroppedCount = 0;
  let imageMessagesPrunedCount = 0;

  const nextMessages = [...messages];

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message.role !== 'user' || !Array.isArray(message.content) || keepImageIndexes.has(index)) {
      continue;
    }

    const hadVisual = hasVisualPart(message.content);
    if (!hadVisual) continue;

    imagePartsDroppedCount += message.content.filter(
      (part) => part.type === 'image_url' || part.type === 'video_url',
    ).length;
    imageMessagesPrunedCount += 1;
    nextMessages[index] = { ...message, content: removeVisualParts(message.content) };
  }

  return { imageMessagesPrunedCount, imagePartsDroppedCount, messages: nextMessages };
};

const mergeAndSlimSystemMessages = (
  messages: OpenAIChatMessage[],
  maxSystemPromptChars: number,
) => {
  const otherMessages: OpenAIChatMessage[] = [];
  const systemTexts: string[] = [];
  let systemRawChars = 0;

  for (const message of messages) {
    if (message.role === 'system' && typeof message.content === 'string') {
      const cleaned = stripWrapperNoise(message.content);
      if (cleaned.length > 0) {
        systemTexts.push(cleaned);
        systemRawChars += cleaned.length;
      }
      continue;
    }

    otherMessages.push(message);
  }

  if (systemTexts.length === 0) {
    return {
      messages,
      systemDroppedDuplicateCount: 0,
      systemMergedCount: 0,
      systemTrimmedChars: 0,
    };
  }

  const uniqueSystemTexts = [...new Set(systemTexts)];
  const merged = uniqueSystemTexts.join('\n\n');
  const finalSystem = trimTextMiddle(merged, maxSystemPromptChars, '\n...[system trimmed]...\n');

  return {
    messages: [{ content: finalSystem, role: 'system' as const }, ...otherMessages],
    systemDroppedDuplicateCount: Math.max(0, systemTexts.length - uniqueSystemTexts.length),
    systemMergedCount: Math.max(0, systemTexts.length - 1),
    systemTrimmedChars: Math.max(0, systemRawChars - finalSystem.length),
  };
};

const applyMessageLevelCleanup = (
  messages: OpenAIChatMessage[],
): {
  base64SegmentsStripped: number;
  duplicateContextBlocksDropped: number;
  messages: OpenAIChatMessage[];
} => {
  const blockSignaturesByTag = new Map<string, Set<string>>();
  const cleaned = [...messages];
  let base64SegmentsStripped = 0;
  let duplicateContextBlocksDropped = 0;

  const latestUserIndex = messages.map((m) => m.role).lastIndexOf('user');

  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    const message = cleaned[index];
    if (typeof message.content !== 'string') continue;

    const shouldKeepFullPayload = index === latestUserIndex;
    let nextContent = message.content;

    if (!shouldKeepFullPayload) {
      nextContent = nextContent.replaceAll(BASE64_DATA_URI_REGEX, () => {
        base64SegmentsStripped += 1;
        return '[omitted historical base64 payload]';
      });
    }

    for (const tag of CONTEXT_BLOCK_TAGS) {
      const regex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi');
      const seen = blockSignaturesByTag.get(tag) ?? new Set<string>();

      nextContent = nextContent.replace(regex, (block) => {
        const signature = block.replaceAll(/\s+/g, ' ').trim();
        if (!shouldKeepFullPayload && seen.has(signature)) {
          duplicateContextBlocksDropped += 1;
          return '';
        }

        seen.add(signature);
        return block;
      });

      blockSignaturesByTag.set(tag, seen);
    }

    cleaned[index] = { ...message, content: stripWrapperNoise(nextContent) };
  }

  return { base64SegmentsStripped, duplicateContextBlocksDropped, messages: cleaned };
};

const truncateAssistantMessages = (
  messages: OpenAIChatMessage[],
  maxAssistantMessageChars: number,
) => {
  let assistantTruncatedCount = 0;
  let assistantTrimmedChars = 0;

  const nextMessages = messages.map((message) => {
    if (message.role !== 'assistant' || typeof message.content !== 'string') return message;
    if (message.tool_calls && message.tool_calls.length > 0) return message;

    if (message.content.length <= maxAssistantMessageChars) return message;
    assistantTruncatedCount += 1;

    const nextContent = trimTextMiddle(message.content, maxAssistantMessageChars);
    assistantTrimmedChars += message.content.length - nextContent.length;

    return { ...message, content: nextContent };
  });

  return { assistantTrimmedChars, assistantTruncatedCount, messages: nextMessages };
};

const selectToolsOnDemand = (
  tools: ChatCompletionTool[] | undefined,
  messages: OpenAIChatMessage[],
  maxTools: number,
) => {
  if (!tools || tools.length === 0) return { tools: undefined, toolsDroppedCount: 0 };

  const recentMessages = messages.slice(-12);
  const recentlyUsedTools = new Set<string>();

  for (const message of recentMessages) {
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        if (call.function?.name) recentlyUsedTools.add(call.function.name);
      }
    }

    if ((message.role === 'tool' || message.role === 'function') && message.name) {
      recentlyUsedTools.add(message.name);
    }
  }

  const latestUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const latestUserText =
    typeof latestUserMessage?.content === 'string'
      ? latestUserMessage.content.toLowerCase()
      : Array.isArray(latestUserMessage?.content)
        ? latestUserMessage.content
            .filter(
              (part): part is Extract<UserMessageContentPart, { type: 'text' }> =>
                part.type === 'text',
            )
            .map((part) => part.text)
            .join('\n')
            .toLowerCase()
        : '';

  const demandedTools = tools.filter((tool) => {
    const toolName = tool.function?.name ?? '';
    if (!toolName) return false;
    return recentlyUsedTools.has(toolName) || latestUserText.includes(toolName.toLowerCase());
  });

  const pickedTools =
    demandedTools.length > 0 ? demandedTools.slice(0, maxTools) : tools.slice(0, maxTools);

  return {
    tools: pickedTools.length > 0 ? pickedTools : undefined,
    toolsDroppedCount: Math.max(0, tools.length - pickedTools.length),
  };
};

export const optimizeChatPayloadForToken = (
  input: PayloadOptimizationInput,
  options?: PayloadOptimizationOptions,
  configOverrides?: Partial<PayloadOptimizationConfig>,
): PayloadOptimizationResult => {
  const config = normalizeConfig(configOverrides);
  const before = summarizeMetrics(input.messages, input.tools);
  const impact: PayloadOptimizationImpact = {
    assistantTrimmedChars: 0,
    assistantTruncatedCount: 0,
    base64SegmentsStripped: 0,
    duplicateContextBlocksDropped: 0,
    historyDroppedCount: 0,
    historyDroppedToolMessages: 0,
    imageMessagesPrunedCount: 0,
    imagePartsDroppedCount: 0,
    systemDroppedDuplicateCount: 0,
    systemMergedCount: 0,
    systemTrimmedChars: 0,
    toolsDroppedCount: 0,
    toolsNameDedupedCount: 0,
  };

  if (!config.enable) {
    return {
      after: before,
      before,
      impact,
      messages: input.messages,
      tools: input.tools,
    };
  }

  const historyTrimmed = trimHistory(input.messages, config.maxHistoryMessages);
  impact.historyDroppedCount = historyTrimmed.historyDroppedCount;
  impact.historyDroppedToolMessages = historyTrimmed.historyDroppedToolMessages;
  let messages = historyTrimmed.messages;

  if (config.slimSystemPrompt) {
    const systemMerged = mergeAndSlimSystemMessages(messages, config.maxSystemPromptChars);
    messages = systemMerged.messages;
    impact.systemDroppedDuplicateCount = systemMerged.systemDroppedDuplicateCount;
    impact.systemMergedCount = systemMerged.systemMergedCount;
    impact.systemTrimmedChars = systemMerged.systemTrimmedChars;
  }

  if (config.stripWrapperNoise) {
    messages = messages.map((message, index) => {
      if (typeof message.content !== 'string') return message;
      const shouldStrip =
        (message.role !== 'user' || index !== messages.length - 1) &&
        WRAPPER_TAG_PATTERNS.some((pattern) =>
          new RegExp(pattern.source, pattern.flags.replace('g', '')).test(message.content),
        );

      if (!shouldStrip) return message;
      return { ...message, content: stripWrapperNoise(message.content) };
    });
  }

  const cleaned = applyMessageLevelCleanup(messages);
  impact.base64SegmentsStripped = cleaned.base64SegmentsStripped;
  impact.duplicateContextBlocksDropped = cleaned.duplicateContextBlocksDropped;
  messages = cleaned.messages;

  const truncated = truncateAssistantMessages(messages, config.maxAssistantMessageChars);
  impact.assistantTrimmedChars = truncated.assistantTrimmedChars;
  impact.assistantTruncatedCount = truncated.assistantTruncatedCount;
  messages = truncated.messages;

  if (config.skipDuplicateOldImages) {
    const dedupedVisuals = dedupeOlderVisualMessages(messages, config.trailingImageMessageCount);
    impact.imageMessagesPrunedCount = dedupedVisuals.imageMessagesPrunedCount;
    impact.imagePartsDroppedCount = dedupedVisuals.imagePartsDroppedCount;
    messages = dedupedVisuals.messages.map((message) => {
      if (
        message.role !== 'user' ||
        !Array.isArray(message.content) ||
        hasVisualPart(message.content)
      ) {
        return message;
      }
      if (message.content.length === 0)
        return { ...message, content: removeVisualParts(message.content) };
      return message;
    });
  }

  const dedupedTools = dedupeTools(input.tools);
  impact.toolsNameDedupedCount = dedupedTools.toolsNameDedupedCount;
  let tools = dedupedTools.tools;

  if (config.onDemandTools) {
    const onDemandResult = selectToolsOnDemand(tools, messages, config.maxTools);
    impact.toolsDroppedCount += onDemandResult.toolsDroppedCount;
    tools = onDemandResult.tools;
  }

  if (config.onDemandTools && options?.canUseFunctionCall === false) {
    impact.toolsDroppedCount += tools?.length ?? 0;
    tools = undefined;
  }

  const after = summarizeMetrics(messages, tools);

  log(
    '[payload-opt] model=%s provider=%s history=%d->%d totalChars=%d->%d tokens=%d->%d system=%d->%d assistant=%d->%d user=%d->%d toolMsg=%d->%d fnMsg=%d->%d wrappers=%d->%d base64=%d->%d imageCount=%d->%d imageUrlChars=%d->%d tools=%d->%d toolsChars=%d->%d impact=%j',
    options?.model ?? 'unknown',
    options?.provider ?? 'unknown',
    before.historyCount,
    after.historyCount,
    before.totalChars,
    after.totalChars,
    before.estimatedTokens,
    after.estimatedTokens,
    before.systemChars,
    after.systemChars,
    before.assistantChars,
    after.assistantChars,
    before.userChars,
    after.userChars,
    before.toolMessageChars,
    after.toolMessageChars,
    before.functionChars,
    after.functionChars,
    before.wrapperChars,
    after.wrapperChars,
    before.base64Chars,
    after.base64Chars,
    before.imageCount,
    after.imageCount,
    before.imageUrlChars,
    after.imageUrlChars,
    before.toolsCount,
    after.toolsCount,
    before.toolsChars,
    after.toolsChars,
    impact,
  );

  return { after, before, impact, messages, tools };
};
