"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = void 0;
class Logger {
    constructor() {
        this.logs = [];
        this.maxLogs = 1000;
        this.enableConsole = true;
        this.enableStorage = true;
        // 私有构造函数，确保单例模式
    }
    static getInstance() {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
    debug(message, context, metadata) {
        this.log('debug', message, context, undefined, metadata);
    }
    info(message, context, metadata) {
        this.log('info', message, context, undefined, metadata);
    }
    warn(message, context, metadata) {
        this.log('warn', message, context, undefined, metadata);
    }
    error(message, error, context, metadata) {
        this.log('error', message, context, error, metadata);
    }
    log(level, message, context, error, metadata) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            context,
            error: error ? this.serializeError(error) : undefined,
            metadata
        };
        this.logs.push(entry);
        // 限制日志数量，避免内存溢出
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        // 输出到控制台
        if (this.enableConsole) {
            this.outputToConsole(entry);
        }
        // 存储到本地（可选）
        if (this.enableStorage) {
            this.saveToStorage(entry);
        }
    }
    serializeError(error) {
        if (error instanceof Error) {
            return {
                name: error.name,
                message: error.message,
                stack: error.stack,
                cause: error.cause ? this.serializeError(error.cause) : undefined
            };
        }
        return {
            message: error?.toString() || 'Unknown error',
            data: error
        };
    }
    outputToConsole(entry) {
        const consoleMessage = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.context ? `[${entry.context}] ` : ''}${entry.message}`;
        switch (entry.level) {
            case 'debug':
                console.debug(consoleMessage, entry.metadata || '', entry.error || '');
                break;
            case 'info':
                console.info(consoleMessage, entry.metadata || '', entry.error || '');
                break;
            case 'warn':
                console.warn(consoleMessage, entry.metadata || '', entry.error || '');
                break;
            case 'error':
                console.error(consoleMessage, entry.metadata || '', entry.error || '');
                break;
        }
    }
    saveToStorage(entry) {
        try {
            // 简单的本地存储实现
            const key = `gemini_log_${Date.now()}`;
            localStorage.setItem(key, JSON.stringify(entry));
            // 清理旧的日志（保留最近100条）
            this.cleanupOldStorageLogs();
        }
        catch (error) {
            console.warn('无法保存日志到本地存储:', error);
        }
    }
    cleanupOldStorageLogs() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith('gemini_log_')) {
                keys.push(key);
            }
        }
        // 按时间排序并删除旧的日志
        keys.sort().reverse();
        const keysToRemove = keys.slice(100);
        keysToRemove.forEach(key => localStorage.removeItem(key));
    }
    getRecentLogs(level, limit = 100) {
        let filteredLogs = this.logs;
        if (level) {
            filteredLogs = this.logs.filter(log => log.level === level);
        }
        return filteredLogs.slice(-limit);
    }
    clearLogs() {
        this.logs = [];
    }
    exportLogs() {
        return JSON.stringify(this.logs, null, 2);
    }
    setConsoleOutput(enabled) {
        this.enableConsole = enabled;
    }
    setStorage(enabled) {
        this.enableStorage = enabled;
    }
}
exports.Logger = Logger;
// 创建全局日志实例
exports.logger = Logger.getInstance();
