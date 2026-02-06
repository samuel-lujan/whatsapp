module.exports = {
  apps: [
    {
      name: 'whatsapp',
      script: 'bash',
      args: '-c "nice -n 5 npm start"', // prioridade um pouco menor que o resto

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,

      // 🧠 Agora podemos subir o limite
      max_memory_restart: '2G',

      // 🔁 Controle de crash
      min_uptime: '120s',
      max_restarts: 10,
      restart_delay: 15000,
      kill_timeout: 35000,       // 35s para graceful shutdown antes do SIGKILL

      // 🧾 Logs
      error_file: '/var/log/pm2-whatsapp-error.log',
      out_file: '/var/log/pm2-whatsapp-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
}
