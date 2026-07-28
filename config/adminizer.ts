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
        ],
    },
}
