import { spawn } from 'child_process';
import path from 'path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AppManager } from "@nodeknit/app-manager";
import express from 'express';
export let webappProcess = null;
/**
 * Функция для проверки занятости порта
 */
export const isPortInUse = (port) => {
    return new Promise((resolve) => {
        const checkProcess = spawn('lsof', ['-i', `:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        checkProcess.stdout.on('data', (data) => {
            output += data.toString();
        });
        checkProcess.on('close', (code) => {
            resolve(output.trim().length > 0);
        });
        checkProcess.on('error', () => {
            // Если lsof недоступен, пробуем netstat
            const netstatProcess = spawn('netstat', ['-tlnp'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let netstatOutput = '';
            netstatProcess.stdout.on('data', (data) => {
                netstatOutput += data.toString();
            });
            netstatProcess.on('close', () => {
                resolve(netstatOutput.includes(`:${port} `));
            });
            netstatProcess.on('error', () => {
                // Если обе команды недоступны, считаем порт свободным
                resolve(false);
            });
        });
    });
};
/**
 * Запуск webapp dev server с проверкой занятости порта
 */
export const startWebappDevServer = async (appManager) => {
    if (process.env.NODE_ENV !== 'development') {
        return;
    }
    // Проверяем, занят ли порт 8080
    const portInUse = await isPortInUse(8080);
    if (!portInUse) {
        // Start webapp dev server только если порт свободен
        webappProcess = spawn('npm', ['run', 'dev'], {
            cwd: path.join(import.meta.dirname, '..', 'webapp'),
            stdio: 'inherit',
            detached: true
        });
        webappProcess.on('error', (err) => {
            AppManager.log.error('Failed to start webapp dev server:', err);
        });
        AppManager.log.info('Webapp dev server started on port 8080');
    }
    else {
        AppManager.log.warn('Port 8080 is already in use, skipping webapp dev server startup');
    }
};
/**
 * Настройка middleware для проксирования запросов к webapp
 */
export const setupWebappProxy = (appManager) => {
    if (process.env.NODE_ENV === 'development') {
        // Proxy / to webapp server, excluding API routes
        appManager.app.use((req, res, next) => {
            if (req.path.startsWith('/graphql') ||
                req.path.startsWith('/health') ||
                req.path.startsWith('/switch') ||
                req.path.startsWith('/api')) {
                return next();
            }
            createProxyMiddleware({
                target: 'http://localhost:8080',
                changeOrigin: true
            })(req, res, next);
        });
    }
    else {
        // Serve static files for production
        appManager.app.use(express.static(path.join(import.meta.dirname, '..', 'webapp', 'dist')));
        // Fallback for SPA
        appManager.app.get('*', (req, res, next) => {
            if (req.path.startsWith('/graphql') ||
                req.path.startsWith('/health') ||
                req.path.startsWith('/switch') ||
                req.path.startsWith('/api')) {
                return next();
            }
            res.sendFile(path.join(import.meta.dirname, '..', 'webapp', 'dist', 'index.html'));
        });
    }
};
/**
 * Остановка webapp dev server
 */
export const stopWebappDevServer = (signal = 'SIGTERM') => {
    if (process.env.NODE_ENV === 'development' && webappProcess) {
        webappProcess.kill(signal);
    }
};
