import { type ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { AGENT_RUNTIME_ERROR_SET } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import debug from 'debug';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { optimizeChatPayloadForToken } from '@/server/modules/AgentRuntime/payloadOptimization';
import { createTraceOptions, initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { type ChatStreamPayload } from '@/types/openai/chat';
import { createErrorResponse } from '@/utils/errorResponse';
import { getTracePayload } from '@/utils/trace';

const log = debug('lobe-server:webapi-chat');

// If user don't use fluid compute, will build  failed
// this enforce user to enable fluid compute
export const maxDuration = 300;

export const POST = checkAuth(async (req: Request, { params, userId, serverDB }) => {
  const provider = (await params)!.provider!;

  try {
    // ============  1. init chat model   ============ //
    const modelRuntime = await initModelRuntimeFromDB(serverDB, userId, provider);

    // ============  2. create chat completion   ============ //

    const inputData = (await req.json()) as ChatStreamPayload;
    const lightweightChatOnly = process.env.SIMPLE_CHAT_ONLY === 'true';
    const data =
      lightweightChatOnly && Array.isArray(inputData.messages)
        ? (() => {
            // SIMPLE_CHAT_ONLY keeps the main chat path in pure conversational mode:
            // short context, minimal system prompt, no tools/function declarations.
            const optimized = optimizeChatPayloadForToken(
              {
                messages: inputData.messages,
                tools: inputData.tools,
              },
              {
                canUseFunctionCall: false,
                lightweightChatOnly: true,
                model: inputData.model,
                provider,
              },
            );

            log(
              '[chat-route] lightweightChatOnly=%s injectedSystem=%s tools=%d history=%d images=%d tokens=%d->%d',
              lightweightChatOnly,
              optimized.messages.some((m) => m.role === 'system'),
              optimized.tools?.length ?? 0,
              optimized.messages.length,
              optimized.after.imageCount,
              optimized.before.estimatedTokens,
              optimized.after.estimatedTokens,
            );

            return {
              ...inputData,
              messages: optimized.messages,
              tools: undefined,
            } satisfies ChatStreamPayload;
          })()
        : inputData;

    const tracePayload = getTracePayload(req);

    let traceOptions = {};
    // If user enable trace
    if (tracePayload?.enabled) {
      traceOptions = createTraceOptions(data, { provider, trace: tracePayload });
    }

    return await modelRuntime.chat(data, {
      user: userId,
      ...traceOptions,
      signal: req.signal,
    });
  } catch (e) {
    const {
      errorType = ChatErrorType.InternalServerError,
      error: errorContent,
      ...res
    } = e as ChatCompletionErrorPayload;

    const error = errorContent || e;

    const logMethod = AGENT_RUNTIME_ERROR_SET.has(errorType as string) ? 'warn' : 'error';
    // track the error at server side
    // eslint-disable-next-line no-console
    console[logMethod](`Route: [${provider}] ${errorType}:`, error);

    return createErrorResponse(errorType, { error, ...res, provider });
  }
});
