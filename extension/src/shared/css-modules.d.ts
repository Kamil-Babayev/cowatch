// esbuild's `.css: 'text'` loader (see build.mjs) turns a CSS import into
// a plain string at bundle time — this just tells tsc the same thing,
// since tsc has no knowledge of esbuild's loader config on its own.
declare module '*.css' {
  const content: string;
  export default content;
}
