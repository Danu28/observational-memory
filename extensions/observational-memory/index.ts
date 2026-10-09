/**
 * Descriptive extension entry point.
 *
 * Pi derives its compact extension label from the entry file path: with the
 * previous manifest (`./src/index.ts`) the `index.ts` segment was stripped and
 * the extension displayed as just `src`. Re-exporting through this
 * `observational-memory/index.ts` entry gives the compact label
 * `observational-memory` instead. Implementation stays in `src/`.
 */
export { default } from "../../src/index.js";
