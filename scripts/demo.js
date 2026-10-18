process.env.DEMO_MODE = 'true';
process.env.PORT ||= '3001';
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
