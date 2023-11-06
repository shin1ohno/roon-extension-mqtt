module.exports = {
  apps: [
    {
      script: '$HOME/.volta/bin/node roon-mqtt.js',
      watch: '.',
      name: 'roon-extention-mqtt',
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
      user: 'ubuntu',
      host: 'workbench.home.local',
      ref: 'origin/master',
      repo: 'https://github.com/shin1ohno/roon-extension-mqtt.git',
      path: '/home/ubuntu/deploy/roon-extension-mqtt-production',
      'post-deploy':
          'export PATH=$HOME/.volta/bin:$PATH && npm install && pm2 reload ecosystem.config.cjs --env production',
    },
  },
}
