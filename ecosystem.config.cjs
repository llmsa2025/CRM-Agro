// Processos do CRM Agro sob o pm2.
//   crmagro-web     Next.js com Socket.IO na porta 3001 (atrás de um proxy HTTPS, veja deploy/Caddyfile.example)
//   crmagro-worker  motor de fluxos e filas (BullMQ)
//
// Uso:  pm2 start ecosystem.config.cjs   |   pm2 startOrReload ecosystem.config.cjs --update-env
// Atenção: `pm2 restart <nome>` NÃO relê este arquivo. Depois de editá-lo, use o startOrReload acima.
const cwd = __dirname;

// Sem min_uptime, um processo que cai depois de 2 s nunca conta como instável e reinicia para sempre.
// Com min_uptime e backoff exponencial, um crash-loop desacelera e para em 20 tentativas.
const restartPolicy = {
  autorestart: true,
  max_restarts: 20,
  min_uptime: "30s",
  exp_backoff_restart_delay: 1000,
};

module.exports = {
  apps: [
    {
      name: "crmagro-web",
      script: "scripts/run-web.sh",
      interpreter: "bash",
      cwd,
      env: { WEB_PORT: "3001" },
      ...restartPolicy,
      // O Next SSR pode crescer com o tempo; reinicia se passar disto (derruba os sockets por instantes).
      max_memory_restart: "900M",
    },
    {
      name: "crmagro-worker",
      script: "scripts/run-worker.sh",
      interpreter: "bash",
      cwd,
      env: { WORKER_PRIMARY: "true" },
      ...restartPolicy,
      max_memory_restart: "800M",
      // Dá tempo de os jobs em andamento terminarem num restart.
      kill_timeout: 180000,
    },
  ],
};
