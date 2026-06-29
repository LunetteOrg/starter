/**
 * Config Stylelint condivisa dello starter.
 *
 * - `standard` + `css-modules`: regole CSS moderne + sintassi dei `*.module.css`
 *   (`:global`, `composes`, ecc.).
 * - `no-unsupported-browser-features`: gate di compatibilità su `browserslist`
 *   (severity `warning`, non blocca: i target li decide il browserslist a root).
 *
 * Biome formatta/lint-a il CSS in modo base; Stylelint aggiunge le regole
 * CSS-specifiche (css-modules, compat browser) che Biome non copre.
 */
export default {
  extends: ['stylelint-config-standard', 'stylelint-config-css-modules'],
  plugins: ['stylelint-no-unsupported-browser-features'],
  rules: {
    'plugin/no-unsupported-browser-features': [
      true,
      {
        severity: 'warning',
        // `css-nesting` è marcato "parziale" da caniuse ma è di fatto usabile.
        ignore: ['css-nesting'],
      },
    ],
    // I nomi-classe dei CSS Modules usano camelCase.
    'selector-class-pattern': [
      '^[a-z][a-zA-Z0-9]*$',
      { message: 'CSS Modules classes use camelCase' },
    ],
    // Target browser larghi: usa la forma classica min-/max-width, non la range.
    'media-feature-range-notation': 'prefix',
  },
}
