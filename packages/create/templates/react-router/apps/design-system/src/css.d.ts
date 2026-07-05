// Side-effect CSS imports (e.g. `import '@starter/ui-tokens/tokens.css'`) have no
// type declarations; TypeScript 6 errors on them without this. Vite handles the
// actual bundling.
declare module '*.css'
