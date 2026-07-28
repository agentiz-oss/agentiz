import { AppManager } from "@nodeknit/app-manager";
export declare let webappProcess: any;
/**
 * Функция для проверки занятости порта
 */
export declare const isPortInUse: (port: number) => Promise<boolean>;
/**
 * Запуск webapp dev server с проверкой занятости порта
 */
export declare const startWebappDevServer: (appManager: AppManager) => Promise<void>;
/**
 * Настройка middleware для проксирования запросов к webapp
 */
export declare const setupWebappProxy: (appManager: AppManager) => void;
/**
 * Остановка webapp dev server
 */
export declare const stopWebappDevServer: (signal?: string) => void;
