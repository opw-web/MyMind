import { WindowsJob } from '../src/main/windows-job';
const job = new WindowsJob(`${process.env.LOCALAPPDATA}/Programs/Ollama/ollama.exe`, { ...process.env, OLLAMA_HOST: '127.0.0.1:11587', OLLAMA_NO_CLOUD: '1' });
console.log({ pid: job.pid, alive: job.alive });
setTimeout(async () => { try { console.log(await (await fetch('http://127.0.0.1:11587/api/version')).json()); } finally { job.close(); console.log({ closed: true, alive: job.alive }); } }, 2000);
