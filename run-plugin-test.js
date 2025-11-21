const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;

Module.prototype.require = function (request) {
    if (request === 'obsidian') {
        // Mock obsidian module
        return {
            App: class { },
            TFile: class { },
            requestUrl: async (...args) => {
                if (global.mockRequestUrl) {
                    return global.mockRequestUrl(...args);
                }
                return { text: '' };
            }
        };
    }
    return originalRequire.apply(this, arguments);
};

console.log("Running plugin-tools.test.js...");
require('./dist_test/test/plugin-tools.test.js');
