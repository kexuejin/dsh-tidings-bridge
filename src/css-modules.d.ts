/**
 * CSS Module ambient declarations.
 *
 * The client bundle inlines `.module.css` through the tsdown plugin in
 * `tsdown.config.ts`, which turns every local class into a hashed global and
 * exports the local→global map. TypeScript needs that shape declared once.
 *
 * ## Why the per-file interface instead of a loose `Record<string, string>`
 *
 * A loose index signature makes `css.typoName` compile happily and render an
 * **empty** class attribute — the element gets no styling and nothing fails.
 * That is exactly how this card shipped its first version: 17 class references,
 * none of which existed in the stylesheet, and no build error to show for it.
 * Declaring the real keys turns a typo into a compile error.
 *
 * The keys are checked against `TidingsSettingsSection.module.css` by a
 * consistency probe (see `scripts/check-client-css.mjs` if it lands; until then
 * the cross-check is the grep in the batch notes).
 */

declare module '*.module.css' {
  /**
   * The exported map is keyed by the class names the stylesheet actually
   * defines — an unknown key is `undefined` at runtime, so typing it as
   * `string | undefined` keeps callers honest.
   */
  const classes: Readonly<Record<string, string | undefined>>
  export default classes
}
