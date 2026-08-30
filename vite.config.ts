import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteExternalsPlugin } from 'vite-plugin-externals';
import path from 'path';

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
        AgentizHome: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizHome.tsx'),
        AgentizTasks: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizTasks.tsx'),
        AgentizPipelines: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizPipelines.tsx'),
        AgentizWorkers: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizWorkers.tsx'),
        AgentizRunDetail: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizRunDetail.tsx'),
        AgentizRuns: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizRuns.tsx'),
        AgentizInteractions: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizInteractions.tsx'),
        AgentizRepositories: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizRepositories.tsx'),
        AgentizNotifications: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizNotifications.tsx'),
        AgentizMembers: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizMembers.tsx'),
        AgentizGitlab: path.resolve(__dirname, 'layers/app-agentiz-gitlab-integration/adminizer/modules/AgentizGitlab.tsx'),
        AgentizGithub: path.resolve(__dirname, 'layers/app-agentiz-github-integration/adminizer/modules/AgentizGithub.tsx'),
        MobileAssistant: path.resolve(__dirname, 'layers/app-agentiz-mobile-api/adminizer/modules/MobileAssistant.tsx'),
        // The workflow canvas is generic and ships inside @nodeknit/app-workflow, but its bundles
        // are built here like every other module: the panel serves one directory, dist/modules.
        // Resolved through node_modules rather than local_modules on purpose — that path is the
        // symlink to the local checkout here and the installed package in CI, where local_modules
        // is empty and a direct path would break the image build.
        WorkflowList: path.resolve(__dirname, 'node_modules/@nodeknit/app-workflow/adminizer/modules/WorkflowList.tsx'),
        WorkflowEditor: path.resolve(__dirname, 'node_modules/@nodeknit/app-workflow/adminizer/modules/WorkflowEditor.tsx'),
      },
      formats: ['es'],
    },
    rollupOptions: { external: ['react', 'react-dom', '@inertiajs/react', 'lucide-react'], output: { entryFileNames: '[name].js' } },
  },
  plugins: [assertCanvasStylesBundled(), react({ jsxRuntime: 'classic' }), viteExternalsPlugin({
    react: 'React', 'react-dom': 'ReactDOM', '@inertiajs/react': 'InertiajsReact', 'lucide-react': 'LucideReact',
    '@/components/ui/button': 'UIComponents', '@/components/ui/card': 'UIComponents', '@/components/ui/dialog': 'UIComponents',
    '@/components/ui/input': 'UIComponents', '@/components/ui/label': 'UIComponents', '@/components/ui/select': 'UIComponents',
    '@/components/ui/tabs': 'UIComponents', '@/components/ui/textarea': 'UIComponents',
  })],
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
