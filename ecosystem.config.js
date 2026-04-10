module.exports = {
  apps: [
    {
      name: 'whatsapp-develop',
      script: 'bash',
      args: '-c "nice -n 5 npm start"',

      env: {
        PORT: 8081,
        NODE_ENV: 'production'
      },

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,

      max_memory_restart: '4G',

      min_uptime: '120s',
      max_restarts: 10,
      restart_delay: 15000,
      kill_timeout: 35000,

      error_file: '/var/log/pm2-whatsapp-develop-error.log',
      out_file: '/var/log/pm2-whatsapp-develop-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
}
