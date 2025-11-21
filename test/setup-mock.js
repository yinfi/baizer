const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;

// Mock window for Node.js environment
global.window = {
    addEventListener: () => { },
    removeEventListener: () => { }
};

// Mock localStorage
global.localStorage = {
    getItem: () => null,
    setItem: () => { },
    removeItem: () => { }
};

Module.prototype.require = function (request) {
    if (request === 'obsidian') {
        return originalRequire.call(this, path.resolve(__dirname, 'mock-obsidian.js'));
    }
    return originalRequire.apply(this, arguments);
};
