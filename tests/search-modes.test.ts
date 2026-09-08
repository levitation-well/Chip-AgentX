import { describe, expect, it } from 'vitest';
import {
  containsChatImageInput,
  listSearchModeCatalog,
  resolveSearchModeAvailability,
  resolveSearchModeSelection
} from '../src/search-modes.js';

describe('search mode catalog and resolver', () => {
  it('defines the trusted server mode catalog without secrets', () => {
    const modes = listSearchModeCatalog();

    expect(modes.map((mode) => mode.id)).toEqual(['standard', 'enhanced', 'multimodal']);
    expect(modes).toEqual([
      expect.objectContaining({
        id: 'standard',
        defaultModelId: 'haiku',
        creditUnits: 50,
        capabilities: ['text']
      }),
      expect.objectContaining({
        id: 'enhanced',
        defaultModelId: 'sonnet',
        creditUnits: 100,
        capabilities: ['text', 'long-context', 'multi-doc', 'scope-search']
      }),
      expect.objectContaining({
        id: 'multimodal',
        defaultModelId: 'opus',
        creditUnits: 150,
        capabilities: ['text', 'image-input', 'multimodal']
      })
    ]);
    expect(JSON.stringify(modes)).not.toMatch(/key|token|secret|password/i);
  });

  it('returns visible disabled reasons for unauthorized and low-credit modes', () => {
    const modes = resolveSearchModeAvailability({
      entryPoint: 'web-chat',
      role: 'customer',
      userModelGrants: ['haiku'],
      creditBalanceUnits: 80
    });

    expect(modes.find((mode) => mode.id === 'standard')).toMatchObject({
      visible: true,
      selectable: true,
      available: true,
      allowsImageInput: false
    });
    expect(modes.find((mode) => mode.id === 'enhanced')).toMatchObject({
      visible: true,
      selectable: false,
      disabledReasons: expect.arrayContaining([
        expect.objectContaining({ code: 'MODEL_NOT_AUTHORIZED' }),
        expect.objectContaining({ code: 'INSUFFICIENT_CREDITS' })
      ])
    });
    expect(modes.find((mode) => mode.id === 'multimodal')).toMatchObject({
      visible: true,
      selectable: false,
      allowsImageInput: true,
      disabledReason: 'This mode is not available to this identity.'
    });
  });

  it('enforces mode and model consistency before selection succeeds', () => {
    expect(
      resolveSearchModeSelection({
        entryPoint: 'web-chat',
        requestedMode: 'standard',
        requestedModelId: 'opus',
        role: 'admin',
        creditBalanceUnits: 999
      })
    ).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'MODE_MODEL_MISMATCH'
    });

    expect(
      resolveSearchModeSelection({
        entryPoint: 'web-chat',
        requestedModelId: 'sonnet',
        role: 'admin',
        creditBalanceUnits: 999
      })
    ).toMatchObject({
      ok: true,
      chatMode: 'enhanced',
      modelId: 'sonnet',
      creditUnits: 100
    });
  });

  it('requires an image-capable entry point for multimodal mode', () => {
    const result = resolveSearchModeSelection({
      entryPoint: 'remote-mcp',
      requestedMode: 'multimodal',
      role: 'admin',
      creditBalanceUnits: 999
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 403,
      code: 'ENTRY_NOT_SUPPORTED'
    });
  });

  it('keeps web upload gated by multimodal model availability', () => {
    expect(
      resolveSearchModeSelection({
        entryPoint: 'web-upload',
        requestedMode: 'multimodal',
        role: 'customer',
        userModelGrants: ['haiku'],
        creditBalanceUnits: 999
      })
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      code: 'MODEL_NOT_AUTHORIZED'
    });

    expect(
      resolveSearchModeSelection({
        entryPoint: 'web-upload',
        requestedMode: 'multimodal',
        role: 'customer',
        userModelGrants: ['opus'],
        creditBalanceUnits: 999
      })
    ).toMatchObject({
      ok: true,
      chatMode: 'multimodal',
      modelId: 'opus'
    });
  });

  it('rejects chat image references unless the actual mode allows image input', () => {
    const imageText = 'Please inspect /api/chat-uploads/00000000-0000-4000-8000-000000000001/file.png?token=redacted';
    expect(containsChatImageInput(imageText)).toBe(true);

    expect(
      resolveSearchModeSelection({
        entryPoint: 'web-chat',
        requestedMode: 'standard',
        role: 'admin',
        creditBalanceUnits: 999,
        includesImageInput: true
      })
    ).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'IMAGE_INPUT_NOT_ALLOWED'
    });

    expect(
      resolveSearchModeSelection({
        entryPoint: 'web-chat',
        requestedMode: 'multimodal',
        role: 'admin',
        creditBalanceUnits: 999,
        includesImageInput: true
      })
    ).toMatchObject({
      ok: true,
      chatMode: 'multimodal',
      modelId: 'opus'
    });
  });
});
