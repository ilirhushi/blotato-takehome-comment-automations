import type { Platform } from '../core/types.js';
import { instagram } from './instagram.js';
import type { PlatformAdapter } from './types.js';

const adapters: Record<Platform, PlatformAdapter> = { instagram };

export function getAdapter(platform: Platform): PlatformAdapter {
  return adapters[platform];
}
