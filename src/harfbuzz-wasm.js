// Worker only (imported first by src/worker.js, before satori loads). satori shapes text with harfbuzz, which its
// build carries as inline bytes and compiles with WebAssembly.instantiate on first use. A Worker can't compile
// wasm at run time (workerd refuses), and satori's renders then waited forever. The same binary ships as
// harfbuzzjs/hb.wasm (satori's own pinned dependency); wrangler compiles it at deploy, and this hands that
// module over when asked to compile bytes of its exact size. test/worker.test.js checks the two are identical.
import harfbuzz from 'harfbuzzjs/hb.wasm';

// hb.wasm's size in bytes (harfbuzzjs 0.10.0). Nothing from satori is imported here: this must run before it loads.
const HARFBUZZ_WASM_BYTES = 381964;

const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  if (!(source instanceof WebAssembly.Module) && source?.byteLength === HARFBUZZ_WASM_BYTES) {
    return instantiate.call(WebAssembly, harfbuzz, imports).then((instance) => ({ module: harfbuzz, instance }));
  }
  return instantiate.call(WebAssembly, source, imports);
};
