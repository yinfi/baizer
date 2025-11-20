const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;

Module.prototype.require = function (request) {
    if (request === 'obsidian') {
        return originalRequire.call(this, path.resolve(__dirname, 'dist_test/test/mock-obsidian.js'));
    }
    return originalRequire.apply(this, arguments);
};

console.log("Running functional-test.js...");
require('./dist_test/test/functional-test.js');

console.log("\nRunning mcp-integration.test.js...");
require('./dist_test/test/mcp-integration.test.js');
