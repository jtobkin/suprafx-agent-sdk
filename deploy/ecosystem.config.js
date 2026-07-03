// pm2 process config for the bullish SUPRA accumulator.
//
//   npm install -g pm2
//   pm2 start deploy/ecosystem.config.js      # starts (DRY_RUN unless LIVE=1 set)
//   pm2 logs supra-accumulator                # watch it
//   pm2 save && pm2 startup                    # survive reboot (follow printed sudo cmd)
//
// Runtime config (MASTER_ADDRESS, QUOTE_ASSETS, MAX_PREMIUM_BPS, LIVE)
// lives in ~/.suprafx/accumulator.env — NOT here, NOT in git.
module.exports = {
  apps: [
    {
      name: "supra-accumulator",
      script: "deploy/run-accumulator.sh",
      interpreter: "bash",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      time: true,
    },
  ],
};
