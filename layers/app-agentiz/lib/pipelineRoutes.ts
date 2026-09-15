import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentRole } from '../models/AgentRole';
import { PipelineSpec } from '../models/PipelineSpec';
import { assertValidSpec, PipelineSpecError } from '../services/PipelineSpecResolver';
import { guardProject, panelActor, requestAccessCache, requirePanelUser } from './access/panelGuard';
import { can } from './access/projectAccess';
import { PROJECT_TOKENS } from './access/tokens';
import { legacyRedirect } from './panel/legacyRedirect';
import { pipelineBoard, pipelineRowPatch } from './panel/pipelinesPanel';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * ACP-agent assignment and pipeline-spec editing for one project: which role runs which stage, in
 * what workspace, and what runs before/after. Split out of the project overview so editing a
 * pipeline is its own screen instead of a block buried in the middle of a long page.
 *
 * Reading the configuration is `project-read`; changing any of it is `project-configure`, the
 * token the Мейнтейнер step of the role ladder is the first to carry. `validateSpec` needs no
 * project at all — it is a pure schema check on a document the caller already holds — so it asks
 * only for a session.
 */
export const pipelineRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-pipelines',
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query._method);
      if (!requirePanelUser(req, res)) return undefined;

      if (method === 'getPipelineConfiguration') {
        const projectId = str(req.query.projectId);
        if (!await guardProject(req, res, projectId, PROJECT_TOKENS.read)) return undefined;
        const [roles, specs] = await Promise.all([
          AgentRole.findAll({ where: { projectId }, order: [['key', 'ASC']] }),
          PipelineSpec.findAll({ where: { projectId }, order: [['updatedAt', 'DESC']] }),
        ]);
        return res.json({
          data: {
            roles: roles.map((role) => ({
              id: role.id, key: role.key, title: role.title, model: role.model,
              config: role.config ?? {}, updatedAt: role.updatedAt,
            })),
            specs: specs.map((spec) => spec.toJSON()),
          },
        });
      }

      // What `lib/panel/render.ts` paints the first frame with, so the reload after a write is
      // shaped exactly like the page it replaces. Separate from `getPipelineConfiguration` above
      // rather than folded into it: that answer is also read by the `agentiz.repository.trigger`
      // node's config form and by the previous editor, and widening a payload two other screens
      // pick fields out of is how they break with nothing failing.
      if (method === 'getPipelineBoard') {
        const projectId = str(req.query.projectId);
        if (!await guardProject(req, res, projectId, PROJECT_TOKENS.read)) return undefined;
        const specId = str(req.query.specId);
        return res.json({
          data: await pipelineBoard(projectId, {
            // Reading the pipelines of a project is `project-read`; changing any of them is
            // `project-configure`, so the flag only decides which controls the screen draws.
            canConfigure: await can(panelActor(req), projectId, PROJECT_TOKENS.projectConfigure, requestAccessCache(req)),
            specId: specId || undefined,
          }),
        });
      }

      // A spec belongs to a project and never moves between projects, so the bare address — which
      // used to open a project picker — lands on the project list.
      return legacyRedirect(req, res, 'projects');
    },
  },
  {
    route: '/agentiz-pipelines',
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);
        if (!requirePanelUser(req, res)) return undefined;

        if (method === 'updatePipelineSpec') {
          const specId = str(req.body?.specId);
          const spec = req.body?.spec;
          if (!specId) return res.status(400).json({ message: 'specId is required' });
          const pipelineSpec = await PipelineSpec.findByPk(specId);
          if (!pipelineSpec) return res.status(404).json({ message: 'Pipeline Spec not found' });
          if (!await guardProject(req, res, pipelineSpec.projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          // The row's own columns (name, matchTags, isActive) travel beside the document, because
          // they are the same edit to the person making it — but only the ones actually named in
          // the body are written, so a caller sending just `{specId, spec}` (which is every call
          // the previous editor made) updates exactly what it always did. `projectId` is not in
          // that list: the model refuses to move a spec between projects.
          const patch = pipelineRowPatch(req.body);
          if (spec !== undefined) patch.spec = spec;
          if (Object.keys(patch).length === 0) {
            return res.status(400).json({ message: 'Nothing to update: send `spec`, `name`, `matchTags` or `isActive`' });
          }
          await pipelineSpec.update(patch);
          return res.json({ data: pipelineSpec.toJSON() });
        }

        if (method === 'setRoleAcpProvider') {
          const roleId = str(req.body?.roleId);
          const provider = str(req.body?.provider);
          if (!roleId) return res.status(400).json({ message: 'roleId is required' });
          const role = await AgentRole.findByPk(roleId);
          if (!role) return res.status(404).json({ message: 'Agent role not found' });
          if (!await guardProject(req, res, role.projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          const presets: Record<string, string[]> = {
            codex: ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.14'],
            claude: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.66.0'],
          };
          const acpCommand = presets[provider];
          if (!acpCommand) return res.status(400).json({ message: 'provider must be codex or claude' });
          await role.update({ config: { executor: 'openhands-acp', provider, acpCommand } });
          return res.json({ data: role.toJSON() });
        }

        if (method === 'validateSpec') {
          try {
            assertValidSpec(req.body?.spec);
            return res.json({ data: { valid: true } });
          } catch (error) {
            if (error instanceof PipelineSpecError) {
              return res.status(400).json({ message: error.message, errors: error.errors });
            }
            throw error;
          }
        }

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
