const path = require('node:path');
const root = path.resolve(__dirname, '..');
module.exports = {
    apps: [{
        name: 'ME-AI',
        script: path.join(root, 'index.js'),
        cwd: root,
        instances: 1,
        exec_mode: 'fork',
        watch: false,
        autorestart: true,
        restart_delay: 5000,
        min_uptime: '30s',
        max_restarts: 10,
        max_memory_restart: '512M',
        kill_timeout: 205000,
        time: true,
        out_file: path.join(root, 'logs/out.log'),
        error_file: path.join(root, 'logs/error.log'),
        env: { NODE_ENV: 'production' },
    }],
};
