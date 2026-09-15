import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteExternalsPlugin } from 'vite-plugin-externals';
import path from 'path';
import fs from 'fs';

/** Emitted next to the module bundles and handed to the panel as `moduleComponentCSS`. */
const MODULE_STYLESHEET = 'agentiz.css';

/** Directories `agentiz.css` declares with `@source`. The two lists must not drift apart. */
const MODULE_DIRS = [
    'layers/app-agentiz/adminizer/modules',
    'layers/app-agentiz-mobile-api/adminizer/modules',
];

/**
 * Every shadcn component the panel mounts on `window.UIComponents` (adminizer
 * `src/assets/js/ui-globals.ts`). Importing the path gives the types; the value is the panel's
 * own already-mounted component, so Radix never enters our bundle and there is exactly one
 * instance of each provider on the page. Importing the values from `adminizer/ui/*` instead does
 * not work and never did — that export was removed in 5.1.0-build.28.
 */
const UI_COMPONENT_MODULES = [
    'avatar', 'badge', 'breadcrumb', 'button', 'calendar', 'card', 'checkbox', 'collapsible',
    'command', 'context-menu', 'dialog', 'dialog-stack', 'dropdown-menu', 'input', 'label',
    'menubar', 'pagination', 'popover', 'select', 'separator', 'sheet', 'sidebar', 'skeleton',
    'slider', 'sonner', 'switch', 'table', 'tabs', 'textarea', 'tooltip',
];

/**
 * Every class our modules use has to exist in the stylesheet we ship, because the panel's own
 * Tailwind cannot contain it: it is built in the adminizer repository, scanning adminizer's
 * sources. Before `agentiz.css` existed, 22 of the 114 classes the modules already used had no
 * rule anywhere — and a missing utility is invisible, the element simply renders unstyled.
 *
 * The check is therefore not "did the file build" but "does the built file cover the markup".
 * It catches the three ways this goes wrong silently: a module in a directory no `@source` line
 * names, a class Tailwind does not recognise (a typo such as `text-md`), and — the expensive one —
 * a theme import gone missing, which drops every scale-based utility at once while still emitting
 * a plausible-looking file.
 */
function assertModuleClassesCovered() {
    /**
     * `className="a b c"` and `className={…}` — string literals inside the expression only.
     *
     * Every string inside the expression counts as a class, which is also a small rule for the
     * modules: keep comparisons out of a `className` (`status === 'cancelled' ? …` reports
     * `cancelled` as a missing utility). Hoist the boolean to a `const` above the JSX.
     */
    const CLASS_ATTR = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([\s\S]*?)\})/g;
    const STRING_IN_EXPR = /(?:"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`)/g;
    /** A plausible utility: lowercase, no interpolation, nothing left over from the JSX. */
    const UTILITY = /^[a-z0-9][a-z0-9:_[\]/.,%!#()+-]*$/;
    /** The characters Tailwind backslash-escapes when it writes a class as a selector. */
    const CSS_SPECIAL = /[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/;

    /**
     * The selector Tailwind would emit for this class, as a regex. Two escapes stack here and
     * getting only one of them right is why the first version of this check reported 23 classes
     * that were present: CSS writes `gap-1.5` as `.gap-1\.5`, so the pattern has to match a
     * literal backslash *and* keep the `.` from meaning "any character".
     */
    function selectorPattern(cls: string): RegExp {
        let source = '';
        for (const ch of cls) {
            const literal = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            source += CSS_SPECIAL.test(ch) ? '\\\\' + literal : literal;
        }
        return new RegExp('\\.' + source + '(?![\\w-])');
    }

    /** Display classes that only take effect above a breakpoint — the other half of the pair below. */
    const RESPONSIVE_DISPLAY = /^(?:sm|md|lg|xl|2xl):(?:block|flex|inline|inline-block|inline-flex|grid|table)$/;

    function collect(code: string, into: Set<string>, pairs: Set<string>) {
        for (const attr of code.matchAll(CLASS_ATTR)) {
            const literal = attr[1] ?? attr[2];
            const chunks: string[] = [];
            if (literal !== undefined) chunks.push(literal);
            else if (attr[3]) for (const inner of attr[3].matchAll(STRING_IN_EXPR)) chunks.push(inner[1] ?? inner[2] ?? inner[3] ?? '');
            for (const chunk of chunks) {
                const tokens = chunk.split(/\s+/).filter((token) => token && UTILITY.test(token));
                for (const token of tokens) into.add(token);
                // Per attribute, not per file: `hidden` somewhere else in the module says nothing.
                if (tokens.includes('hidden')) for (const token of tokens) if (RESPONSIVE_DISPLAY.test(token)) pairs.add(token);
            }
        }
    }

    return {
        name: 'agentiz:assert-module-classes',
        generateBundle(_options: unknown, bundle: Record<string, any>) {
            const sheet = bundle[MODULE_STYLESHEET];
            if (!sheet || sheet.type !== 'asset') {
                throw new Error(
                    `${MODULE_STYLESHEET} was not emitted. Modules would load with only the panel's own ` +
                        'Tailwind, which does not contain our classes. Check the css entry in build.lib.entry.',
                );
            }
            const css = String(sheet.source);

            const used = new Set<string>();
            const pairs = new Set<string>();
            for (const dir of MODULE_DIRS) {
                const root = path.resolve(__dirname, dir);
                for (const file of fs.readdirSync(root, {recursive: true, encoding: 'utf8'})) {
                    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
                    collect(fs.readFileSync(path.resolve(root, file), 'utf8'), used, pairs);
                }
            }

            /**
             * `hidden md:block` cannot work here, and it fails **silently** — the element simply
             * never appears. Our utilities sit in the `components` layer, below the panel's own
             * (`agentiz.css`; the one time they shared a layer we hid the panel's sidebar on every
             * Agentiz page), so the panel's `.hidden{display:none}` outranks any responsive display
             * class of ours whatever the media query says. It works for `md:block` only by
             * accident — that class happens to exist in the panel's sheet too. Write the single
             * class instead: `max-md:hidden`, which nothing of the panel's competes with.
             */
            if (pairs.size) {
                throw new Error(
                    `A module pairs "hidden" with ${[...pairs].join(', ')} in one className. Our utilities ` +
                        "live in the `components` layer, so the panel's own `.hidden` wins and the element " +
                        'never shows. Use a single `max-<breakpoint>:hidden` class instead.',
                );
            }

            const missing = [...used].filter((cls) => !selectorPattern(cls).test(css)).sort();
            if (missing.length) {
                throw new Error(
                    `${missing.length} class(es) used by a module have no rule in ${MODULE_STYLESHEET}:\n  ` +
                        missing.join('\n  ') +
                        '\n\nEither the directory is missing an @source line in ' +
                        'layers/app-agentiz/adminizer/styles/agentiz.css, or the class does not exist in Tailwind.',
                );
            }
        },
    };
}

/**
 * The workflow canvas carries React Flow's stylesheet inside its own bundle (the panel loads one
 * `.js` per module and nothing else), and a missing stylesheet is invisible: React Flow still
 * mounts, the nodes are still in the DOM, and nothing is logged — the canvas just stops being a
 * canvas, because `.react-flow__node { position: absolute }` is what places a node and lets it be
 * dragged. That has already shipped once, so the build asserts it instead of trusting the import:
 * `?inline` silently yields an empty string for a css file resolved out of `node_modules`, which is
 * exactly the layout the Docker image builds in and the local checkout never does.
 */
function assertCanvasStylesBundled() {
  return {
    name: 'agentiz:assert-canvas-styles',
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      const chunk = bundle['WorkflowEditor.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      if (!/\.react-flow__node\s*\{/.test(chunk.code)) {
        throw new Error(
          'WorkflowEditor.js contains no React Flow stylesheet — the canvas would render unusable. ' +
            'Check the css import in @nodeknit/app-workflow adminizer/modules/lib/injectStyles.ts ' +
            '(`?raw`, not `?inline`) and that @xyflow/react is installed.',
        );
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist/modules', emptyOutDir: true, cssCodeSplit: true,
    lib: {
      entry: {
        // One module for the whole /agentiz address tree: the shell, the route switch and every
        // screen behind it. The thirteen per-screen modules it replaced were deleted in stage 9 of
        // `.ai-notes/ui-1-sol/03-plan.md`, together with the addresses that rendered them — those
        // now answer `302` and nothing else.
        AgentizApp: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizApp.tsx'),
        // Not a page: the config editor of one workflow node, loaded by the canvas through
        // NodeTypeDefinition.ui. Built here like every other module — the panel serves one
        // directory, dist/modules.
        AgentizRepositoryTriggerForm: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizRepositoryTriggerForm.tsx'),
        MobileAssistant: path.resolve(__dirname, 'layers/app-agentiz-mobile-api/adminizer/modules/MobileAssistant.tsx'),
        // The workflow canvas is generic and ships inside @nodeknit/app-workflow, but its bundles
        // are built here like every other module: the panel serves one directory, dist/modules.
        // Resolved through node_modules rather than local_modules on purpose — that path is the
        // symlink to the local checkout here and the installed package in CI, where local_modules
        // is empty and a direct path would break the image build.
        WorkflowList: path.resolve(__dirname, 'node_modules/@nodeknit/app-workflow/adminizer/modules/WorkflowList.tsx'),
        WorkflowEditor: path.resolve(__dirname, 'node_modules/@nodeknit/app-workflow/adminizer/modules/WorkflowEditor.tsx'),
        // Not a module: the stylesheet every module needs, built through the same pipeline so it
        // lands in the one directory the panel serves. Delivered per page as `moduleComponentCSS`.
        agentiz: path.resolve(__dirname, 'layers/app-agentiz/adminizer/styles/agentiz.css'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', '@inertiajs/react', 'lucide-react', 'axios', 'sonner'],
      // No hash in either name: the panel addresses both by a fixed path (`moduleComponent` /
      // `moduleComponentCSS`), not through a manifest, so a name that moves cannot be found.
      //
      // The `?v=` that `adminizerModuleUrl()` appends to the `.js` is therefore not a contradiction
      // — it is the only cache-busting available to a fixed path, and it is safe *here*. What once
      // gave the panel two copies of React and a white screen was `?v=` on adminizer's own `app.js`:
      // an entry whose code-split chunks import it back by bare name, and an ES module's identity
      // is its full URL *including* the query, so the browser instantiated it twice. Our entries
      // are imported by nobody — the chunks below are leaves — which is the condition that makes
      // the query harmless. Adding an entry that a chunk imports back would break that.
      // The stylesheet stays unversioned for a different reason (see `adminizerModuleUrl.ts`):
      // the panel deduplicates `<link>` by path. `serveStatic` sends an ETag either way.
      output: { entryFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
  },
  plugins: [
    assertCanvasStylesBundled(),
    assertModuleClassesCovered(),
    react({ jsxRuntime: 'classic' }),
    viteExternalsPlugin({
      react: 'React', 'react-dom': 'ReactDOM', '@inertiajs/react': 'InertiajsReact', 'lucide-react': 'LucideReact',
      // The panel already holds these; bundling our own copy would mean a second axios instance
      // without the panel's interceptors and a second sonner with a Toaster nobody mounted.
      axios: 'axios', sonner: 'sonner',
      ...Object.fromEntries(UI_COMPONENT_MODULES.map((name) => [`@/components/ui/${name}`, 'UIComponents'])),
    }),
  ],
  define: { 'process.env': {}, 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../../adminizer/src/assets/js'),
      // Modules are built with the classic JSX transform and share the panel's own React
      // (a global, currently 19.x). Third-party ESM compiled with the automatic runtime — React
      // Flow — would otherwise drag the project's react@18 jsx-runtime into the bundle, giving
      // the page a second, older React that dies on its first hook. The shim routes those imports
      // back onto the one React that is already there.
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/@nodeknit/app-workflow/adminizer/modules/lib/jsxRuntimeShim.ts'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/@nodeknit/app-workflow/adminizer/modules/lib/jsxRuntimeShim.ts'),
    },
    extensions: ['.js', '.ts', '.tsx'],
  },
});
