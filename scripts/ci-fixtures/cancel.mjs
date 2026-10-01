import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("child heartbeat\\n"),1000)'], {stdio:'inherit'})
process.stdout.write(`owned-child=${child.pid}\n`)
setInterval(() => process.stdout.write('parent heartbeat\n'), 1000)
