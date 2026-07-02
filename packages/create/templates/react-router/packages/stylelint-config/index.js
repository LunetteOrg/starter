/**
 * Shared Stylelint config for the starter.
 *
 * - `standard` + `css-modules`: modern CSS rules + `*.module.css` syntax
 *   (`:global`, `composes`, etc.).
 * - `no-unsupported-browser-features`: a compatibility gate over `browserslist`
 *   (severity `warning`, non-blocking: the targets are decided by the root browserslist).
 *
 * Biome formats/lints CSS at a basic level; Stylelint adds the CSS-specific
 * rules (css-modules, browser compat) that Biome doesn't cover.
 */
export default {
  extends: ['stylelint-config-standard', 'stylelint-config-css-modules'],
  plugins: ['stylelint-no-unsupported-browser-features'],
  rules: {
    'plugin/no-unsupported-browser-features': [
      true,
      {
        severity: 'warning',
        // `css-nesting` is flagged "partial" by caniuse but is usable in practice.
        ignore: ['css-nesting'],
      },
    ],
    // CSS Modules class names use camelCase.
    'selector-class-pattern': [
      '^[a-z][a-zA-Z0-9]*$',
      { message: 'CSS Modules classes use camelCase' },
    ],
    // Broad browser targets: use the classic min-/max-width form, not the range.
    'media-feature-range-notation': 'prefix',
  },
}
