import test from 'node:test';import assert from 'node:assert/strict';import { captureResourceSnapshot } from '../extensions/mainline-supervision/src/capture.mjs';
test('macOS reports free and total memory without inventing Linux available or swap values',()=>{
 const x=captureResourceSnapshot({platform:'darwin',totalmem:()=>4096,freemem:()=>1024});
 assert.equal(x.values.MemTotalKiB,4);assert.equal(x.values.MemFreeKiB,1);assert.equal(x.values.MemAvailableKiB,undefined);assert.equal(x.values.SwapFreeKiB,undefined);
});
test('Linux requires all expected meminfo fields',()=>{
 assert.throws(()=>captureResourceSnapshot({platform:'linux',readMeminfo:()=> 'MemAvailable: 42 kB\n'}),/Required resource field/);
 const x=captureResourceSnapshot({platform:'linux',readMeminfo:()=> 'MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 20 kB\nSwapFree: 10 kB\n'});assert.equal(x.values.MemAvailableKiB,50);
});
