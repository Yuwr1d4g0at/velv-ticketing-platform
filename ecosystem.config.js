module.exports = {
  apps: [
    {
      name: "velv-ticketing",
      script: "src/server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
