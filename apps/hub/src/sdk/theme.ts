/**
 * Azure DevOps theme plumbing.
 *
 * The host pushes its theme to the extension frame as CSS custom
 * properties on `:root` (the SDK injects a `<style>` element and fires a
 * `themeApplied` event). `theme.css` maps those onto our own `--eg-*`
 * tokens with fallbacks, so light and dark both work and a standalone
 * `vite dev` run still looks right.
 */
import type { ThemeVariables } from './types';

/** The event the SDK fires on `window` each time the host re-themes. */
export const THEME_APPLIED_EVENT = 'themeApplied';

/**
 * Theme variables we read back for components that need a value in JS
 * rather than in CSS. Names are the host's, without the `--` prefix.
 */
export const OBSERVED_THEME_VARIABLES = [
  'background-color',
  'text-primary-color',
  'text-secondary-color',
  'text-disabled-color',
  'communication-background',
  'communication-foreground',
  'palette-neutral-0',
  'palette-neutral-2',
  'palette-neutral-4',
  'palette-neutral-8',
  'palette-neutral-10',
  'palette-neutral-20',
  'palette-neutral-30',
  'palette-neutral-60',
  'palette-neutral-80',
  'palette-neutral-100',
  'palette-primary',
  'palette-error',
  'palette-accent1',
  'palette-accent2',
  'palette-accent3',
] as const;

/** Reads the observed theme custom properties off the document root. */
export function readThemeVariables(doc: Document = document): ThemeVariables {
  const root = doc.documentElement;
  const computed = doc.defaultView?.getComputedStyle(root);
  if (!computed) return {};
  const out: Record<string, string> = {};
  for (const name of OBSERVED_THEME_VARIABLES) {
    const value = computed.getPropertyValue(`--${name}`).trim();
    if (value !== '') out[name] = value;
  }
  return out;
}

/**
 * Writes theme variables onto a target element as `--<name>` custom
 * properties. Used by the fake host and by the standalone dev shell.
 */
export function applyThemeVariables(
  variables: ThemeVariables,
  target: HTMLElement = document.documentElement,
): void {
  for (const [name, value] of Object.entries(variables)) {
    target.style.setProperty(`--${name}`, value);
  }
}

/**
 * Subscribes to host re-themes. Returns an unsubscribe function; callers
 * must call it on unmount so nothing leaks.
 */
export function observeHostTheme(
  listener: (variables: ThemeVariables) => void,
  view: Window = window,
): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    listener(isThemeVariables(detail) ? detail : readThemeVariables());
  };
  view.addEventListener(THEME_APPLIED_EVENT, handler);
  return () => {
    view.removeEventListener(THEME_APPLIED_EVENT, handler);
  };
}

function isThemeVariables(value: unknown): value is ThemeVariables {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}

/**
 * Best-effort light/dark read, for the rare component that must branch in
 * JS. CSS should use the `--eg-*` tokens instead.
 */
export function isDarkTheme(variables: ThemeVariables): boolean {
  const background = variables['palette-neutral-0'] ?? '';
  const parts = background.split(',').map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [r = 0, g = 0, b = 0] = parts;
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}
