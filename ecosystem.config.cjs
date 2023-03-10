module.exports = {
  apps: [
    {
      script: '/opt/homebrew/bin/node ./lib/src/index.js',
      watch: '.',
      name: 'nuimo-mqtt',
      env_production: {
        NODE_ENV: 'production',
        BROKER_URL: 'mqtt://mqbroker.home.local:1883'
      },
      env_development: {
        NODE_ENV: 'development',
        BROKER_URL: 'mqtt://localhost:1883'
      }
    }
  ],
  deploy: {
    production: {
      user: 'shin1ohno',
      host: 'mini.home.local',
      ref: 'origin/main',
      repo: 'https://github.com/shin1ohno/nuimo-mqtt.git',
      path: '/Users/shin1ohno/deploy/nuimo-mqtt-production',
      'post-deploy':
          '$HOME/.volta/bin/npm install && rm -rf lib && $HOME/.volta/bin/npm run build && /opt/homebrew/bin/pm2 reload ecosystem.config.cjs --env production',
    },
  },
}
