import { AdminizerConfig } from "@nodeknit/app-adminizer"
import path from "path"
import { readFileSync } from 'fs';

const packageJsonPath = path.resolve(process.cwd(), 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const gitSha = process.env.GIT_SHA ? process.env.GIT_SHA.slice(0, 8) : null;
const buildTime = process.env.BUILD_TIME ?? null;
const versionParts = [packageJson.version, gitSha, buildTime].filter(Boolean);

export const adminizerConfig: AdminizerConfig = {
    showVersion: versionParts.join(' | '),
    routePrefix: "/dashboard",
    auth: {
        enable: true,
        captcha: false
    },
    models: {
    },
    security: {
      csrf: false
    },
    // The bell in the panel's header. Agentiz sends its own class of notifications into it
    // (layers/app-agentiz/lib/notifications) — a pending agent question today, more later. Behind
    // an env flag because the subsystem is marked experimental in adminizer: turning it off must
    // not need a rebuild, and with it off Agentiz simply sends nothing.
    notifications: {
        enabled: (process.env.ADMINIZER_NOTIFICATIONS ?? "true") === "true",
        enableGeneral: true,
        initTab: "agentiz",
    },
    // The knowledge base of the panel. Adminizer needs both switches: this flag and a registered
    // implementation — app-adminizer registers one as soon as a module contributes articles
    // through the `documentation` collection (layers/app-agentiz/docs/panel is the first).
    documentation: {
        enabled: (process.env.ADMINIZER_DOCUMENTATION ?? "true") === "true",
    },
    aiAssistant: {
        enabled: (process.env.OPENHARNESS_ENABLED ?? "true") === "true",
        defaultModel: "agentiz-assistant",
        models: ["agentiz-assistant"],
    },
    brand: {
        link: {
            id: 'brand',
            title: 'Agentiz',
            link: '/',
            type: 'self',
        },
    },
    navbar: {
        additionalLinks: [
            {
                id: 'agentiz-home',
                title: 'Agentiz',
                link: '/dashboard/agentiz',
                type: 'self',
                icon: 'smart_toy',
                section: 'Agentiz',
            },
            {
                id: 'agentiz-tasks',
                title: 'Задачи',
                link: '/dashboard/agentiz-tasks',
                type: 'self',
                icon: 'checklist',
                section: 'Agentiz',
            },
            {
                id: 'agentiz-runs',
                title: 'Запуски',
                link: '/dashboard/agentiz-runs',
                type: 'self',
                icon: 'directions_run',
                section: 'Agentiz',
            },
            {
                id: 'agentiz-interactions',
                title: 'Нужен ответ',
                link: '/dashboard/agentiz-interactions',
                type: 'self',
                icon: 'live_help',
                section: 'Agentiz',
            },
            {
                id: 'workflows',
                title: 'Воркфлоу',
                link: '/dashboard/workflows',
                type: 'self',
                icon: 'account_tree',
                section: 'Agentiz',
            },
            {
                id: 'agentiz-gitlab',
                title: 'GitLab-интеграции',
                link: '/dashboard/agentiz-gitlab',
                type: 'self',
                icon: 'hub',
                section: 'Agentiz',
            },
        ],
    },
}
