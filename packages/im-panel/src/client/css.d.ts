/**
 * The stylesheet import the bundle build resolves with esbuild's `text` loader:
 * the artifact carries the CSS as a string and the browser half injects it once.
 *
 * @module dsh-im-panel/client/css
 */

declare module '*.css' {
  /** The stylesheet's text. */
  const text: string
  export default text
}
