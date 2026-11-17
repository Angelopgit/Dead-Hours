import { GAME } from '@dead-hours/shared';

declare const __DH_BUILD__: string | undefined;

/**
 * The game's version and which build of it this is (vite.config.ts names each build). The night
 * of a player-hosted game runs in the host's browser, so everyone in it must run the very build
 * the host does: a tab left open since before an update would otherwise disagree with the host
 * about what the night's messages mean. The room refuses anyone else and tells them to refresh.
 */
export const BUILD = `${GAME.version}+${typeof __DH_BUILD__ === 'string' ? __DH_BUILD__ : 'dev'}`;
