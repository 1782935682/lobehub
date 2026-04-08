import type { ChatCompletionTool, OpenAIChatMessage } from '@lobechat/model-runtime';
import { describe, expect, it } from 'vitest';

import { optimizeChatPayloadForToken } from '../payloadOptimization';

const buildTool = (name: string): ChatCompletionTool => ({
  function: {
    description: `tool ${name}`,
    name,
    parameters: { properties: { q: { type: 'string' } }, type: 'object' },
  },
  type: 'function',
});

describe('optimizeChatPayloadForToken', () => {
  it('should trim history and truncate long assistant history content', () => {
    const messages: OpenAIChatMessage[] = [
      { content: 'system', role: 'system' },
      ...Array.from({ length: 8 }).flatMap((_, index) => [
        { content: `u-${index}`, role: 'user' as const },
        { content: `a-${index}-${'x'.repeat(60)}`, role: 'assistant' as const },
      ]),
    ];

    const result = optimizeChatPayloadForToken(
      { messages },
      {},
      {
        maxAssistantMessageChars: 30,
        maxHistoryMessages: 6,
      },
    );

    expect(result.messages.length).toBe(7);
    expect(result.messages[0].role).toBe('system');
    expect(
      result.messages.some(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.includes('[truncated]'),
      ),
    ).toBe(true);
    expect(result.after.estimatedTokens).toBeLessThan(result.before.estimatedTokens);
  });

  it('should skip old images but keep trailing image messages', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          { image_url: { url: 'data:image/png;base64,aaa' }, type: 'image_url' },
          { text: 'old image text', type: 'text' },
        ],
        role: 'user',
      },
      { content: 'reply', role: 'assistant' },
      {
        content: [
          { image_url: { url: 'data:image/png;base64,bbb' }, type: 'image_url' },
          { text: 'latest image text', type: 'text' },
        ],
        role: 'user',
      },
    ];

    const result = optimizeChatPayloadForToken(
      { messages },
      {},
      {
        trailingImageMessageCount: 1,
      },
    );

    expect(result.before.imageCount).toBe(2);
    expect(result.after.imageCount).toBe(1);
    expect(result.messages[0].content).toEqual([{ text: 'old image text', type: 'text' }]);
  });

  it('should keep non-empty placeholder when old image-only message is pruned', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [{ image_url: { url: 'data:image/png;base64,aaa' }, type: 'image_url' }],
        role: 'user',
      },
      { content: 'reply', role: 'assistant' },
      {
        content: [{ image_url: { url: 'data:image/png;base64,bbb' }, type: 'image_url' }],
        role: 'user',
      },
    ];

    const result = optimizeChatPayloadForToken(
      { messages },
      {},
      {
        trailingImageMessageCount: 1,
      },
    );

    expect(result.messages[0].content).toBe('[historical image omitted]');
  });

  it('should dedupe tools and remove tools when function calling is disabled', () => {
    const tools = [buildTool('search'), buildTool('search'), buildTool('weather')];

    const deduped = optimizeChatPayloadForToken(
      { messages: [{ content: 'hi', role: 'user' }], tools },
      { canUseFunctionCall: true },
    );
    expect(deduped.tools?.length).toBe(2);

    const disabled = optimizeChatPayloadForToken(
      { messages: [{ content: 'hi', role: 'user' }], tools },
      { canUseFunctionCall: false },
    );
    expect(disabled.tools).toBeUndefined();
  });

  it('should compact verbose tool schema noise without dropping tool semantics', () => {
    const tools: ChatCompletionTool[] = [
      {
        function: {
          description: `search tool ${'x'.repeat(600)}`,
          name: 'search',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: {
              q: {
                description: `query ${'y'.repeat(300)}`,
                examples: ['weather in shanghai'],
                title: 'Query',
                type: 'string',
              },
            },
            required: ['q'],
            title: 'SearchParams',
            type: 'object',
          },
        },
        type: 'function',
      },
    ];

    const result = optimizeChatPayloadForToken(
      { messages: [{ content: 'hi', role: 'user' }], tools },
      {},
    );
    const schema = result.tools?.[0].function.parameters as {
      properties: {
        q: { description?: string; examples?: string[]; title?: string; type: string };
      };
      title?: string;
      type: string;
    };

    expect(result.tools?.[0].function.description!.length).toBeLessThan(
      tools[0].function.description!.length,
    );
    expect(schema.title).toBeUndefined();
    expect(schema.properties.q.title).toBeUndefined();
    expect(schema.properties.q.examples).toBeUndefined();
    expect(schema.properties.q.type).toBe('string');
    expect(result.impact.toolSchemaFieldsDroppedCount).toBeGreaterThan(0);
    expect(result.after.toolsChars).toBeLessThan(result.before.toolsChars);
  });

  it('should merge and trim duplicated system messages', () => {
    const messages: OpenAIChatMessage[] = [
      { content: 'You are helpful', role: 'system' },
      { content: 'You are helpful', role: 'system' },
      { content: `policy:${'x'.repeat(160)}`, role: 'system' },
      { content: 'question', role: 'user' },
    ];

    const result = optimizeChatPayloadForToken(
      { messages },
      {},
      {
        maxSystemPromptChars: 80,
      },
    );

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBe(1);
    expect(typeof systemMessages[0].content).toBe('string');
    expect((systemMessages[0].content as string).includes('[system trimmed]')).toBe(true);
    expect(result.impact.systemMergedCount).toBe(2);
    expect(result.impact.systemDroppedDuplicateCount).toBe(1);
  });

  it('should remove duplicate context blocks and strip historical base64 payload', () => {
    const duplicatedBlock = '<files_info>\nA\n</files_info>';
    const base64 = 'data:image/png;base64,' + 'a'.repeat(240);
    const messages: OpenAIChatMessage[] = [
      { content: `${duplicatedBlock}\n${base64}`, role: 'user' },
      { content: 'ok', role: 'assistant' },
      { content: duplicatedBlock, role: 'user' },
    ];

    const result = optimizeChatPayloadForToken({ messages }, {});

    expect(typeof result.messages[0].content).toBe('string');
    expect((result.messages[0].content as string).includes('<files_info>')).toBe(false);
    expect(
      (result.messages[0].content as string).includes('[omitted historical base64 payload]'),
    ).toBe(true);
    expect(result.impact.duplicateContextBlocksDropped).toBeGreaterThan(0);
    expect(result.impact.base64SegmentsStripped).toBeGreaterThan(0);
  });

  it('should keep only latest image messages and prune old image context', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          { image_url: { url: 'https://example.com/old.png' }, type: 'image_url' },
          { text: 'old image text', type: 'text' },
        ],
        role: 'user',
      },
      { content: 'reply', role: 'assistant' },
      {
        content: [{ image_url: { url: 'https://example.com/new.png' }, type: 'image_url' }],
        role: 'user',
      },
    ];

    const result = optimizeChatPayloadForToken(
      { messages },
      {},
      {
        trailingImageMessageCount: 1,
      },
    );

    expect(result.messages[0].content).toEqual([{ text: 'old image text', type: 'text' }]);
    expect(result.after.imageCount).toBe(1);
    expect(result.impact.imagePartsDroppedCount).toBe(1);
  });

  it('should enforce lightweight chat mode with minimal system and no tools', () => {
    const messages: OpenAIChatMessage[] = [
      { content: 'legacy system instruction', role: 'system' },
      ...Array.from({ length: 12 }).flatMap((_, index) => [
        { content: `u-${index}`, role: 'user' as const },
        { content: `a-${index}-${'z'.repeat(1000)}`, role: 'assistant' as const },
      ]),
    ];
    const tools = [buildTool('search')];

    const result = optimizeChatPayloadForToken(
      { messages, tools },
      { lightweightChatOnly: true, model: 'gpt-4o', provider: 'openai' },
    );

    expect(result.tools).toBeUndefined();
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain("Use the user's current language");
    expect(result.messages.length).toBeLessThanOrEqual(9);
    expect(result.impact.toolsDroppedCount).toBeGreaterThan(0);
  });

  it('should strip wrapper blocks in lightweight chat mode', () => {
    const messages: OpenAIChatMessage[] = [
      {
        content:
          '<!-- SYSTEM CONTEXT -->\n<files_info>\nA\n</files_info>\n<available_skills>\nB\n</available_skills>\nhello',
        role: 'user',
      },
    ];

    const result = optimizeChatPayloadForToken(
      { messages },
      { lightweightChatOnly: true, model: 'gpt-4o', provider: 'openai' },
    );

    expect(typeof result.messages[1].content).toBe('string');
    expect((result.messages[1].content as string).includes('<files_info>')).toBe(false);
    expect((result.messages[1].content as string).includes('<available_skills>')).toBe(false);
    expect((result.messages[1].content as string).includes('SYSTEM CONTEXT')).toBe(false);
  });

  it('should drop stale tool history in lightweight chat mode', () => {
    const messages: OpenAIChatMessage[] = [
      { content: 'legacy system instruction', role: 'system' },
      {
        content: '',
        role: 'assistant',
        tool_calls: [{ function: { arguments: '{}', name: 'search' }, id: 'call_1', type: 'function' }],
      },
      { content: '{"result":"old"}', name: 'search', role: 'tool', tool_call_id: 'call_1' },
      { content: 'follow-up question', role: 'user' },
    ];

    const result = optimizeChatPayloadForToken(
      { messages, tools: [buildTool('search')] },
      { lightweightChatOnly: true, model: 'gpt-4o', provider: 'openai' },
    );

    expect(result.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(
      result.messages.some(
        (message) => message.role === 'assistant' && !!message.tool_calls?.length,
      ),
    ).toBe(false);
    expect(result.impact.lightweightToolMessagesDroppedCount).toBe(1);
    expect(result.impact.lightweightAssistantToolCallMessagesDroppedCount).toBe(1);
  });
});
