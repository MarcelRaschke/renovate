import { logger } from '~test/util.ts';
import { GlobalConfig } from '../../config/global.ts';
import { getAiLanguageModel } from './index.ts';

describe('util/ai/index', () => {
  afterEach(() => {
    GlobalConfig.reset();
  });

  it('returns null when no AI provider is configured', () => {
    expect(getAiLanguageModel()).toBeNull();
  });

  it('returns null and warns when aiProviderBaseUrl is missing', () => {
    GlobalConfig.set({
      aiProviderType: 'openai-compatible',
      aiProviderModel: 'llama3.1',
    });

    expect(getAiLanguageModel()).toBeNull();
    expect(logger.logger.warn).toHaveBeenCalledWith(
      { aiProviderType: 'openai-compatible' },
      'aiProviderBaseUrl and aiProviderModel must both be set when aiProviderType is set, skipping AI provider setup',
    );
  });

  it('returns null and warns when aiProviderModel is missing', () => {
    GlobalConfig.set({
      aiProviderType: 'openai-compatible',
      aiProviderBaseUrl: 'http://localhost:11434/v1',
    });

    expect(getAiLanguageModel()).toBeNull();
    expect(logger.logger.warn).toHaveBeenCalledWith(
      { aiProviderType: 'openai-compatible' },
      'aiProviderBaseUrl and aiProviderModel must both be set when aiProviderType is set, skipping AI provider setup',
    );
  });

  it('returns an openai-compatible language model for a local Ollama server', () => {
    GlobalConfig.set({
      aiProviderType: 'openai-compatible',
      aiProviderBaseUrl: 'http://localhost:11434/v1',
      aiProviderModel: 'llama3.1',
    });

    const model = getAiLanguageModel();

    expect(model).not.toBeNull();
    expect(model).toMatchObject({
      modelId: 'llama3.1',
      provider: 'renovate.chat',
    });
  });

  it('supports an optional aiProviderApiKey', () => {
    GlobalConfig.set({
      aiProviderType: 'openai-compatible',
      aiProviderBaseUrl: 'http://localhost:8080/v1',
      aiProviderModel: 'llama3.1',
      aiProviderApiKey: 'sk-some-key',
    });

    const model = getAiLanguageModel();

    expect(model).not.toBeNull();
    expect(model).toMatchObject({ modelId: 'llama3.1' });
  });
});
