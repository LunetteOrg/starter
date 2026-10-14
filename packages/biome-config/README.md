# @lntt/biome-config

The Biome config every Lunette project extends, and the GritQL plugins its overrides
mount. Kept current by version, so a project raises the package instead of editing a
copy.

```sh
pnpm add -D -w @lntt/biome-config @biomejs/biome
```

```jsonc
// biome.json at the project root
{
  "extends": ["@lntt/biome-config/biome"],
  "overrides": [
    {
      "includes": ["apps/*/app/**/*.ts", "!**/*.spec.ts", "!**/*.test.ts"],
      "plugins": ["./node_modules/@lntt/biome-config/no-throw-new-error.grit"]
    }
  ]
}
```

Biome resolves `extends` by package name; a plugin is a path, so it points into
`node_modules`.

## The config

Formatter: two spaces, 100 columns, single quotes, no semicolons. Linter: the
`recommended` preset. VCS: git, honouring `.gitignore`. `*.grit` files are not
formatted.

## The plugins

| Plugin | Flags | Mount it on |
|---|---|---|
| `no-throw-new-error.grit` | `throw new <Name>Error(…)`; framework signals (`throw redirect(…)`) pass | app code |
| `no-entity-spread-in-loader.grit` | an object spread in a `return` (`return { ...entity }`), never an array spread | route modules (loaders and actions) |
| `no-implicit-e2e-sync.grit` | `page.waitForTimeout(…)` | e2e tests |
| `no-react-internals.grit` | `__reactProps$` / `__reactFiber$` keys | e2e tests |

The messages cite the ADRs of a project scaffolded from the Lunette `react-router`
template (`docs/adr/architecture-and-boundaries.md`), where each rule's reason is
recorded. `no-entity-spread-in-loader` and `no-throw-new-error` are the editor and
pre-commit net; the matching CI net is the architecture tests of the test-utils
package (today the template's `packages/test-utils`, extracted as `@lntt/test-utils`).
