/**
 * Module declaration for CSS assets imported with `with { type: "file" }`.
 *
 * Bun resolves such an import to a string file path (and embeds the file into a
 * `--compile` binary), but TypeScript has no built-in declaration for `.css`
 * modules and would otherwise fail to resolve the import. The actual value is
 * coerced to `string` at the import site in `src/server.ts`.
 */
declare module "*.css";
