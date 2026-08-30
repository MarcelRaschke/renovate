import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { GlobalConfig } from '../../config/global.ts';
import { logger } from '../../logger/index.ts';

const AI_PROVIDER_NAME = 'renovate';

/**
 * Builds a `LanguageModel` from the `aiProvider*` global config options, for use with the
 * [Vercel AI SDK](https://ai-sdk.dev/) (`generateText`, `streamText`, etc.).
 *
 * Returns `null` if no AI provider is configured (`aiProviderType` is unset), or if
 * `aiProviderBaseUrl`/`aiProviderModel` are missing.
 */
export function getAiLanguageModel(): LanguageModel | null {
  const {
    aiProviderType,
    aiProviderBaseUrl,
    aiProviderModel,
    aiProviderApiKey,
  } = GlobalConfig.get();

  if (!aiProviderType) {
    return null;
  }

  if (!aiProviderBaseUrl || !aiProviderModel) {
    logger.warn(
      { aiProviderType },
      'aiProviderBaseUrl and aiProviderModel must both be set when aiProviderType is set, skipping AI provider setup',
    );
    return null;
  }

  // `aiProviderType` currently only supports `'openai-compatible'`, which covers any
  // OpenAI-compatible API, for example a self-hosted Ollama or llama.cpp server.
  return createOpenAICompatible({
    name: AI_PROVIDER_NAME,
    baseURL: aiProviderBaseUrl,
    apiKey: aiProviderApiKey,
  })(aiProviderModel);
}
