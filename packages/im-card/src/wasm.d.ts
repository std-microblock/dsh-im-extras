/** The slice of the WebAssembly JS API this package uses (absent from @types/node without the DOM lib). */
declare namespace WebAssembly {
  class Module {
    constructor(bytes: BufferSource)
  }
}
type BufferSource = ArrayBufferView | ArrayBuffer
