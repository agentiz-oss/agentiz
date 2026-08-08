import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteExternalsPlugin } from 'vite-plugin-externals';
import path from 'path';

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
        AgentizRepositories: path.resolve(__dirname, 'layers/app-agentiz/adminizer/modules/AgentizRepositories.tsx'),
        AgentizGitlab: path.resolve(__dirname, 'layers/app-agentiz-gitlab-integration/adminizer/modules/AgentizGitlab.tsx'),
        AgentizGithub: path.resolve(__dirname, 'layers/app-agentiz-github-integration/adminizer/modules/AgentizGithub.tsx'),
        MobileAssistant: path.resolve(__dirname, 'layers/app-agentiz-mobile-api/adminizer/modules/MobileAssistant.tsx'),
      },
      formats: ['es'],
    },
    rollupOptions: { external: ['react', 'react-dom', '@inertiajs/react', 'lucide-react'], output: { entryFileNames: '[name].js' } },
  },
  plugins: [react({ jsxRuntime: 'classic' }), viteExternalsPlugin({
    react: 'React', 'react-dom': 'ReactDOM', '@inertiajs/react': 'InertiajsReact', 'lucide-react': 'LucideReact',
    '@/components/ui/button': 'UIComponents', '@/components/ui/card': 'UIComponents', '@/components/ui/dialog': 'UIComponents',
    '@/components/ui/input': 'UIComponents', '@/components/ui/label': 'UIComponents', '@/components/ui/select': 'UIComponents',
    '@/components/ui/tabs': 'UIComponents', '@/components/ui/textarea': 'UIComponents',
  })],
  define: { 'process.env': {}, 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') },
  resolve: { alias: { '@': path.resolve(__dirname, '../../../adminizer/src/assets/js') }, extensions: ['.js', '.ts', '.tsx'] },
});
