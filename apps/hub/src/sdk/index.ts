/**
 * Host boundary: the Azure DevOps SDK handshake, the token accessor, the
 * theme bridge and a fake implementation of the same interface.
 */
export type {
  HubHost,
  HubHostContext,
  InitHubHostOptions,
  ThemeVariables,
} from './types';
export {
  buildWorkItemUrl,
  createHubHost,
  createTokenAccessor,
  HostHandshakeError,
  initHubHost,
} from './adoHost';
export {
  createFakeHubHost,
  FAKE_DARK_THEME,
  FAKE_HOST_CONTEXT,
  FAKE_LIGHT_THEME,
} from './fakeHost';
export type { FakeHubHost, FakeHubHostOptions } from './fakeHost';
export {
  applyThemeVariables,
  isDarkTheme,
  observeHostTheme,
  OBSERVED_THEME_VARIABLES,
  readThemeVariables,
  THEME_APPLIED_EVENT,
} from './theme';
export {
  HostProvider,
  useHostContext,
  useHubHost,
  useOptionalHubHost,
  useThemeVariables,
} from './HostProvider';
export type { HostProviderProps } from './HostProvider';
