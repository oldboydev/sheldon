const args = process.argv.slice(2);

if (process.env.SECRET_TOKEN) process.exit(4);

if (args.includes('--version')) {
  const home = process.env.HOME || process.env.USERPROFILE ? 'home-forwarded' : 'home-missing';
  const xai = process.env.XAI_API_KEY ? 'xai-forwarded' : 'xai-missing';
  const grokHome = process.env.GROK_HOME ? 'grok-home-forwarded' : 'grok-home-missing';
  process.stdout.write(`fixture 1.0 ${home} ${xai} ${grokHome}\n`);
  process.exit(0);
}

if ((args[0] === 'login' && args[1] === 'status') || (args[0] === 'auth' && args[1] === 'status')) {
  process.exit(process.env.HOME || process.env.USERPROFILE ? 0 : 1);
}

process.exit(2);
