import { confluenceAdapter } from './confluence';
import type { PageContext, PlatformAdapter } from './types';
import type { Wiki2mdOptions } from '../core/options';

const adapters: PlatformAdapter[] = [confluenceAdapter];

export function detectPlatform(ctx: PageContext, options: Wiki2mdOptions): PlatformAdapter | null {
  const enabled = {
    confluence: options.platforms.confluence,
    feishu: options.platforms.feishu,
    wechat: options.platforms.wechat
  };

  for (const a of adapters) {
    if (a.id === 'confluence' && !enabled.confluence) continue;
    if (a.id === 'feishu' && !enabled.feishu) continue;
    if (a.id === 'wechat' && !enabled.wechat) continue;
    if (a.matches(ctx)) return a;
  }
  return null;
}
