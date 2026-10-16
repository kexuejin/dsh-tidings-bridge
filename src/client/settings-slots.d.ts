/**
 * The one settings slot this plugin occupies, declared locally.
 *
 * ## Why locally instead of importing \`@deepseek-ai/dsh-client-ui-settings\`
 *
 * That package is the settings domain's base layer, and depending on it drags in
 * \`configForms\` / \`api-remotes\` and their Host-side build artifacts. This plugin
 * needs exactly **one** seat — a section page in the settings navigation — so it
 * declares that seat and nothing else. Same discipline as \`host-services.d.ts\`:
 * state only the surface we actually use.
 *
 * The shapes mirror \`packages/client/ui-settings/src/client/contract/slots.ts\`
 * and \`packages/client/ui-theme/src/client/index.ts\` at 2026-10-14.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { TidingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: \`id\` (section key, drives \`only\` filtering), \`order\` (nav
     * position), \`label\` (registrant-localized display text).
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
  }

  interface LocaleNamespaceMap {
    /** The settings card's copy (see \`locales.ts\`). */
    tidings: TidingsKey
  }
}

/** Owner share of one settings section page: the shell supplies only a way to close. */
export interface SettingsSectionOwnerProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}
