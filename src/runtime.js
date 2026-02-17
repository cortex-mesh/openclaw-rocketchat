/** @type {import('openclaw').Runtime | null} */
let _runtime = null;

export function setRuntime(runtime) {
  _runtime = runtime;
}

export function getRuntime() {
  if (!_runtime) {
    throw new Error('Runtime not initialized — plugin must be registered first');
  }
  return _runtime;
}
