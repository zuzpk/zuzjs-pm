import { defineConfig } from 'tsup';

export default defineConfig({
  // 1. Entry points: index for the lib, bin for the CLI
  entry: {
    index: 'src/index.ts',
    zpm: 'src/cli.ts',
    daemon: `src/daemon.ts`
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: true,
  sourcemap: false,
  clean: true,
  minify: true,
  treeshake: true,
  // Externalize React so it's not bundled
  external: ['react', 'react-dom'],
  // Shims handles __dirname and __filename in ESM
  shims: true,
  // Ensures the bin file has the #!/usr/bin/env node header
  banner: ({ format }) => {
    if (format === 'cjs') return { js: '/* ZuzJS Process Manager */' };
    return {};
  },
  onSuccess: async () => {
    console.log('✅ ZuzJS Process Manager Build Complete');
  }
});