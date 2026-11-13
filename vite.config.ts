import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Relative asset paths, so the built site works from any folder (e.g. user.github.io/repo/).
    base: './',
    server: {
        // The ChimeraX source checkout is reference material, not part of the app.
        watch: { ignored: ['**/ChimeraX/**', '**/.cache/**'] },
    },
    optimizeDeps: { entries: ['index.html'] },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 60_000,
        // molstar ships ES modules without "type": "module", so Vite must transform it.
        server: { deps: { inline: ['molstar'] } },
    },
});
