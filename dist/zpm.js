#!/usr/bin/env node
import {a as a$1}from'./chunk-S27NHT3Z.js';import'./chunk-5RMT5B2R.js';var[,,l,...a]=process.argv,o=new a$1;function m(e){let s={};for(let t=0;t<e.length;t++){let n=e[t];if(n.startsWith("--")){let r=n.slice(2),c=e[t+1];c&&!c.startsWith("--")?(s[r]=c,t++):s[r]=true;}else s._=n;}return s}function p(e){for(let s of e){let t=s.uptime!=null?`${Math.round(s.uptime/1e3)}s`:"\u2013",n=s.memoryRss!=null?`${Math.round(s.memoryRss/1024/1024)} MB`:"\u2013",r=s.cpu!=null?`${s.cpu.toFixed(1)}%`:"\u2013";console.log(`  [${s.status.toUpperCase().padEnd(8)}] ${s.name.padEnd(20)}PID: ${String(s.pid??"\u2013").padEnd(7)}UP: ${t.padEnd(8)}  CPU: ${r.padEnd(7)}  MEM: ${n}  Restarts: ${s.restartCount}`);}}async function d(){switch(l){case "start":{let e=m(a),s=e._;s||(console.error("Usage: zpm start <script> [--name <n>]"),process.exit(1)),await o.ensureDaemon();let t=await o.start({name:e.name??s,scriptPath:s,port:e.port?Number(e.port):void 0,instances:e.instances?Number(e.instances):1,devMode:!!e.dev,mode:e.cluster?"cluster":"fork"});console.log("[ZPM]",t);break}case "stop":{let[e]=a;e||(console.error("Usage: zpm stop <name>"),process.exit(1));let s=await o.stop(e);console.log("[ZPM]",s);break}case "restart":{let[e]=a;e||(console.error("Usage: zpm restart <name>"),process.exit(1));let s=await o.restart(e);console.log("[ZPM]",s);break}case "delete":{let[e]=a;e||(console.error("Usage: zpm delete <name>"),process.exit(1));let s=await o.delete(e);console.log("[ZPM]",s);break}case "list":{let e=await o.list();if(e.length===0){console.log("[ZPM] No workers registered.");break}e.forEach(s=>console.log(" \u2022",s));break}case "stats":{let[e]=a,s=await o.stats(e);if(s.length===0){console.log("[ZPM] No stats available.");break}p(s);break}case "kill-daemon":{await o.killDaemon();break}default:console.log(`
  @zuzjs/pm \u2013 Process Manager

  Commands:
    zpm start  <script>  [--name <n>] [--port <p>] [--instances <i>] [--dev] [--cluster]
    zpm stop   <name>
    zpm restart <name>
    zpm delete  <name>
    zpm list
    zpm stats  [name]
    zpm kill-daemon
      `);}}d().catch(e=>{console.error("[ZPM] Error:",e.message??e),process.exit(1);});