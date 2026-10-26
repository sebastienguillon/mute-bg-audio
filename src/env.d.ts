// Compile-time constants of this project's builds (Vite `define` in wxt.config.ts).
interface ImportMetaEnv {
  /** The look-ahead model of this build: LOOKAHEAD_MODEL when building (default 'kim'). */
  readonly LOOKAHEAD_MODEL: import('./lib/lookahead/models').LookaheadModelName;
}
