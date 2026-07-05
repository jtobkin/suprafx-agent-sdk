// pm2 process config for the bullish SUPRA accumulator.
// NOTE: .cjs extension is required — this repo is an ESM package
// ("type": "module"), and pm2 config must be CommonJS.
//
//   npx pm2 start deploy/ecosystem.config.cjs   # no global install / no sudo
//   npx pm2 logs supra-accumulator              # watch it
//   npx pm2 save                                 # persist across restarts
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
    {
      // Multi-market RFQ liquidity seeder (cookbook/06). Config in
      // ~/.suprafx/seeder.env. Start just this one with:
      //   npx pm2 start deploy/ecosystem.config.cjs --only supra-seeder
      name: "supra-seeder",
      script: "deploy/run-seeder.sh",
      interpreter: "bash",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      time: true,
    },
  ],
};
