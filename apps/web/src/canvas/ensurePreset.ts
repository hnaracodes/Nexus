import type { ApiResult, RoomApi, SavedConfig } from './api.js';
import { presetConfigBody } from './presets.js';
import type { Preset } from './presets.js';

/**
 * Make sure the preset's config exists, WITHOUT ever overwriting one.
 * `saveConfig` is keyed by name and overwrites silently, so a user's edited
 * "Coder" must be left alone: if the library already has a config of that
 * name we do nothing and the caller uses it as it is.
 *
 * On a server refusal the result carries the server's own `problems`
 * (verbatim) and the caller must abort the spawn/add.
 */
export async function ensurePresetConfig(
  preset: Preset,
  configs: readonly SavedConfig[],
  api: Pick<RoomApi, 'saveConfig'>,
): Promise<ApiResult<{ config: SavedConfig; created: boolean }>> {
  const existing = configs.find((c) => c.name === preset.name);
  if (existing !== undefined) return { ok: true, data: { config: existing, created: false } };
  const saved = await api.saveConfig(presetConfigBody(preset));
  return saved.ok ? { ok: true, data: { config: saved.data, created: true } } : saved;
}
