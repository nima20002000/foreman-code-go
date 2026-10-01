import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(() => console.log("ci child heartbeat"), 100)'], { stdio: ['ignore', 'inherit', 'inherit'] })
console.log(`ci parent ${process.pid} child ${child.pid}`)
setInterval(() => console.log('ci parent heartbeat'), 100)
