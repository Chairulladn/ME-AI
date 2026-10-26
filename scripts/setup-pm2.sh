#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
umask 077
mkdir -p logs
chmod 700 logs
# This module bounds PM2 logs, including logs created outside the app.
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 startOrRestart config/ecosystem.config.js --only ME-AI
pm2 save
