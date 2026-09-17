/**
 * Which view a contribution asks for.
 *
 * Both `vss-extension.json` contributions load the same bundle, so this
 * one function is the whole router. It lives apart from `main.tsx`
 * because importing `main.tsx` boots the hub, and the routing rule has to
 * be checkable without an Azure DevOps frame around it.
 */
import type { HubViewId } from './types';

/** The module each view must default-export a React component from. */
export const VIEW_FILE: Record<HubViewId, string> = {
  board: '/BoardView.tsx',
  admin: '/AdminView.tsx',
};

/**
 * Reads the view from the contribution id, with a `?view=` override for
 * local development. Anything unrecognised falls back to the board,
 * because the board is what a hub link means to a user.
 */
export function resolveViewId(
  contributionId: string,
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): HubViewId {
  const override = new URLSearchParams(search).get('view');
  if (override === 'admin' || override === 'board') return override;
  return contributionId.toLowerCase().includes('admin') ? 'admin' : 'board';
}
