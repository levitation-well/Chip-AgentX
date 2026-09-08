import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };
const changelogMarkdown = readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8');

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  define: {
    __AGENTX_PACKAGE_VERSION__: JSON.stringify(packageJson.version ?? '0.1.0'),
    __AGENTX_CHANGELOG_MARKDOWN__: JSON.stringify(changelogMarkdown)
  },
  // ESM/CJS interop for CJS format
  esbuildOptions(options) {
    if (options.format === 'cjs') {
      options.banner = {
        js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
      };
    }
  },
  // External modules from bundle (native binaries and direct dependencies)
  external: ['@lydell/node-pty', '@modelcontextprotocol/sdk', 'tree-kill', 'cac', 'zod'],
});
